import { CollectionFieldPicker } from '@nivaro/shared'
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Settings2 } from 'lucide-react'
import { memo, useRef, useState } from 'react'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Field, ListSpec } from '../api'
import { ConditionRules } from './ConditionRules'
import { humanizePath, listSentence } from './labels'
import { PathPicker } from './PathPicker'
import { countFields } from './spec-ops'
import { FmField, FmLabel, FmPopoverContent, Hint, type ItemScope, TextField } from './ui'

// The header line of a group or list, phrased as a sentence:
// "One per material where quantity > 0, sorted by id, numbered from 1".
// For lists it opens the list settings (source, row name, filter, sort,
// numbering, plain values).

function ListSettings({
  list,
  childCount,
  outerScope,
  itemCollection,
  onPatch,
  onRenameAlias
}: {
  list: ListSpec
  childCount: number
  outerScope: ItemScope | null
  itemCollection?: string
  onPatch: (patch: Partial<ListSpec>) => void
  onRenameAlias: (from: string, to: string) => void
}) {
  // The last non-empty row name: typing "line" → "" → "row" rewrites paths line → row.
  const lastAlias = useRef(list.item || 'line')
  const lastSet = useRef(list.item)
  if (list.item !== lastSet.current) {
    // Changed from outside (undo, Code tab): start from the new name.
    lastSet.current = list.item
    if (list.item) lastAlias.current = list.item
  }
  const alias = list.item
  // The server stores a plain-values list only with exactly one child.
  const scalarBlocked = !list.scalar && childCount > 1
  const scope: ItemScope = { alias: alias || 'line', collection: itemCollection }
  const desc = !!list.sort?.startsWith('-')
  const sortField = (list.sort ?? '').replace(/^-/, '')
  const sortRel = sortField.startsWith(`${scope.alias}.`)
    ? sortField.slice(scope.alias.length + 1)
    : sortField
  return (
    <div className='space-y-3.5'>
      <div>
        <FmLabel>Comes from</FmLabel>
        <PathPicker
          value={list.source}
          onChange={(source) => onPatch({ source })}
          scope={outerScope}
          listSource
          placeholder='Choose a list'
          ariaLabel='List source'
          className='w-full'
        />
        <Hint className='mt-1'>Related data rows, or a list field of the record.</Hint>
      </div>
      <div className='grid grid-cols-2 gap-3'>
        <FmField label='Call each row'>
          <TextField
            mono
            value={alias}
            onChange={(v) => {
              const to = v.replace(/\s+/g, '')
              lastSet.current = to
              if (to) {
                onRenameAlias(lastAlias.current, to)
                lastAlias.current = to
              } else onPatch({ item: '' })
            }}
            placeholder='line'
          />
        </FmField>
        <FmField label='Number rows as'>
          <TextField
            mono
            value={list.number_as ?? ''}
            onChange={(v) => onPatch({ number_as: v.trim() || undefined })}
            placeholder='number'
          />
        </FmField>
        <Hint className='col-span-2 -mt-1.5'>
          Fields inside read <span className='font-mono'>{scope.alias}.quantity</span>; numbering
          counts 1, 2, 3… after the filter.
        </Hint>
      </div>
      <div>
        <FmLabel>Only rows where</FmLabel>
        <ConditionRules
          rules={list.where ?? []}
          scope={scope}
          onChange={(where) => onPatch({ where: where.length ? where : undefined })}
          empty='Every row is sent.'
        />
      </div>
      <div>
        <FmLabel>Sort by</FmLabel>
        <div className='flex items-center gap-1.5'>
          <div className='min-w-0 flex-1'>
            {itemCollection ? (
              <CollectionFieldPicker
                collection={itemCollection}
                value={sortRel}
                valueLabel={sortRel ? humanizePath(sortRel) : undefined}
                onChange={(p) => onPatch({ sort: `${desc ? '-' : ''}${p.path.join('.')}` })}
                onClear={() => onPatch({ sort: undefined })}
                placeholder='As they come'
              />
            ) : (
              <TextField
                mono
                value={sortRel}
                onChange={(v) =>
                  onPatch({ sort: v.trim() ? `${desc ? '-' : ''}${v.trim()}` : undefined })
                }
                placeholder='As they come'
                aria-label='Sort field'
              />
            )}
          </div>
          <button
            type='button'
            disabled={!sortRel}
            aria-pressed={desc}
            onClick={() => onPatch({ sort: `${desc ? '' : '-'}${sortRel}` })}
            data-tip={desc ? 'Highest first' : 'Lowest first'}
            aria-label={desc ? 'Highest first' : 'Lowest first'}
            className='inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40 dark:border-border dark:text-slate-300'
          >
            {desc ? (
              <ArrowDownWideNarrow className='h-3.5 w-3.5' />
            ) : (
              <ArrowUpNarrowWide className='h-3.5 w-3.5' />
            )}
          </button>
        </div>
      </div>
      <label
        className={cn(
          'flex items-start gap-2 text-[12.5px] text-slate-700 dark:text-slate-200',
          scalarBlocked && 'opacity-60'
        )}
      >
        <input
          type='checkbox'
          checked={!!list.scalar}
          disabled={scalarBlocked}
          onChange={(e) => onPatch({ scalar: e.target.checked ? true : undefined })}
          className='mt-0.5 h-3.5 w-3.5 rounded border-slate-300 accent-[#00ceff]'
        />
        <span>
          Plain values, not objects
          <span className='block text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {scalarBlocked ? (
              `Each row has ${childCount} fields — keep one to send plain values.`
            ) : (
              <>
                Sends <span className='font-mono'>["PO-1", "PO-2"]</span> — one value per row
              </>
            )}
          </span>
        </span>
      </label>
    </div>
  )
}

function GroupHeaderImpl({
  field,
  outerScope,
  itemCollection,
  collapsed,
  onPatchList,
  onRenameAlias
}: {
  field: Field
  outerScope: ItemScope | null
  itemCollection?: string
  collapsed: boolean
  onPatchList: (id: string, patch: Partial<ListSpec>) => void
  onRenameAlias: (id: string, from: string, to: string) => void
}) {
  // A list without a source can't be saved: open its settings the moment it appears.
  const [open, setOpen] = useState(() => field.type === 'list' && !field.list?.source)
  const count = countFields(field.children)
  if (field.type === 'object')
    return (
      <span className='truncate text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        A group of {count} {count === 1 ? 'field' : 'fields'}
        {collapsed ? ' (folded)' : ''}
      </span>
    )
  const parts = listSentence(field.list)
  const missing = !field.list?.source
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-value-chip=''
          className={cn(
            'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 text-left text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
            missing
              ? 'border-dashed border-slate-300 text-slate-500 dark:border-slate-600 dark:text-muted-foreground'
              : 'border-transparent text-slate-600 hover:border-slate-200 dark:text-slate-300 dark:hover:border-border',
            open && 'border-nvr-cyan'
          )}
        >
          <Settings2 className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
          <span className='min-w-0 truncate'>
            {parts.map((p, i) =>
              p.bold ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: static sentence parts
                <strong key={i} className='font-semibold text-slate-900 dark:text-foreground'>
                  {p.text}
                </strong>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: static sentence parts
                <span key={i}>{p.text}</span>
              )
            )}
          </span>
        </button>
      </PopoverTrigger>
      <FmPopoverContent className='w-[400px] p-3'>
        <ListSettings
          list={field.list ?? { source: '', item: 'line' }}
          childCount={field.children?.length ?? 0}
          outerScope={outerScope}
          itemCollection={itemCollection}
          onPatch={(patch) => onPatchList(field.id, patch)}
          onRenameAlias={(from, to) => onRenameAlias(field.id, from, to)}
        />
      </FmPopoverContent>
    </Popover>
  )
}

export const GroupHeader = memo(GroupHeaderImpl)
