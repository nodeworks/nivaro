import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Lock } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { FieldRenderer } from '../item-edit/FieldRenderer'
import type { CMSField, CMSRelation } from '../item-edit/types'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Skeleton } from '../ui/skeleton'
import {
  type BulkFieldOption,
  type BulkFieldsReport,
  bulkFieldNote,
  bulkFieldSections
} from './bulk-field-options'

/**
 * Bulk "Update field" by form (#2722): an anchored panel beside the bar's
 * button. It lists only the fields on the selected records' form, in its
 * sections; a field the form locks for the person reads as locked with the
 * form's reason, and one only some records take says how many. The value is
 * edited with the form's own input. The write itself is the bar's
 * (`onApply`) — the server refuses locked and off-form fields per record too.
 */
export function BulkFieldUpdate({
  collection,
  selectedIds,
  disabled,
  className,
  onApply,
  onSaveRecipe
}: {
  collection: string
  selectedIds: Array<string | number>
  disabled?: boolean
  className?: string
  onApply: (field: string, value: unknown) => void
  onSaveRecipe?: (field: string, value: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (!disabled || !o) setOpen(o)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={disabled}
          data-bulk-update-field
          className={className}
          aria-haspopup='dialog'
        >
          Update Field
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='end'
        sideOffset={8}
        className='w-[380px] max-w-[calc(100vw-24px)] p-0'
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {open && (
          <BulkFieldPanel
            collection={collection}
            selectedIds={selectedIds}
            onCancel={() => setOpen(false)}
            onApply={(f, v) => {
              setOpen(false)
              onApply(f, v)
            }}
            onSaveRecipe={
              onSaveRecipe
                ? (f, v) => {
                    setOpen(false)
                    onSaveRecipe(f, v)
                  }
                : undefined
            }
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function BulkFieldPanel({
  collection,
  selectedIds,
  onCancel,
  onApply,
  onSaveRecipe
}: {
  collection: string
  selectedIds: Array<string | number>
  onCancel: () => void
  onApply: (field: string, value: unknown) => void
  onSaveRecipe?: (field: string, value: unknown) => void
}) {
  const client = useNivaroClient()
  const idsKey = useMemo(() => selectedIds.map(String).join(','), [selectedIds])
  const report = useQuery<BulkFieldsReport>({
    queryKey: ['bulk-fields', collection, idsKey],
    queryFn: () =>
      client
        .request<{ data: BulkFieldsReport }>(
          post(`/items/${collection}/bulk-fields`, { ids: selectedIds })
        )
        .then((r) => r.data),
    staleTime: 15_000,
    retry: false
  })
  const fieldConfig = useQuery<CMSField[]>({
    queryKey: ['bulk-fields-config', collection],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(get(`/field-config/${collection}`))
        .then((r) => (Array.isArray(r.data) ? r.data : [])),
    staleTime: 60_000
  })
  const relations = useQuery<CMSRelation[]>({
    queryKey: ['bulk-fields-relations', collection],
    queryFn: () =>
      client
        .request<{ data: CMSRelation[] }>(get(`/data-model/relations/for/${collection}`))
        .then((r) => (Array.isArray(r.data) ? r.data : [])),
    staleTime: 60_000
  })

  const labels = useMemo(() => {
    const out: Record<string, string | null> = {}
    for (const f of fieldConfig.data ?? []) out[f.field] = f.label
    return out
  }, [fieldConfig.data])
  const sections = useMemo(
    () => (report.data ? bulkFieldSections(report.data, labels) : []),
    [report.data, labels]
  )
  const [picked, setPicked] = useState<BulkFieldOption | null>(null)
  const [value, setValue] = useState<unknown>(null)

  const total = report.data?.readable ?? selectedIds.length
  const forms = report.data?.forms ?? []
  const subtitle = !report.data
    ? null
    : forms.length === 0
      ? 'These records have no form, so every field you may change is listed.'
      : forms.length === 1
        ? `Fields on their form, ${forms[0].name}.`
        : `Fields on their ${forms.length} forms, ${forms[0].name} first.`

  if (picked) {
    const cfg = (fieldConfig.data ?? []).find((f) => f.field === picked.field)
    const note = bulkFieldNote(picked, total)
    return (
      <div className='flex flex-col' data-bulk-field-value>
        <div className='flex items-center gap-2 border-b border-border px-3 py-2.5'>
          <button
            type='button'
            onClick={() => {
              setPicked(null)
              setValue(null)
            }}
            aria-label='Choose another field'
            data-tip='Choose another field'
            className='rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
          >
            <ArrowLeft className='h-3.5 w-3.5' />
          </button>
          <div className='min-w-0'>
            <p className='truncate text-[13px] font-semibold text-foreground'>Set {picked.label}</p>
            <p className='text-[11.5px] text-muted-foreground'>
              On {picked.writable} of {total} record{total === 1 ? '' : 's'}
            </p>
          </div>
        </div>
        <div className='space-y-2 px-3 py-3'>
          {cfg ? (
            <FieldRenderer
              field={{ ...cfg, readonly: false } as Parameters<typeof FieldRenderer>[0]['field']}
              value={value}
              onChange={setValue}
              relations={(relations.data ?? []) as Parameters<typeof FieldRenderer>[0]['relations']}
              collection={collection}
              itemId='new'
            />
          ) : (
            <input
              // biome-ignore lint/a11y/noAutofocus: the one input of this step
              autoFocus
              value={value == null ? '' : String(value)}
              onChange={(e) => setValue(e.target.value)}
              aria-label={`New ${picked.label}`}
              className='h-9 w-full rounded-md border border-input bg-background px-3 text-[13px] text-foreground focus-visible:border-nvr-cyan focus-visible:outline-none'
            />
          )}
          <p className='text-[11.5px] leading-4 text-muted-foreground'>
            {value == null || value === ''
              ? `Leave it empty to clear ${picked.label} on every record.`
              : 'Records that already hold this value are left as they are.'}
          </p>
          {note && (
            <p
              className='text-[11.5px] leading-4 text-amber-700 dark:text-amber-300'
              data-bulk-field-note
            >
              {note.charAt(0).toUpperCase() + note.slice(1)}. Those records are skipped.
            </p>
          )}
        </div>
        <div className='flex items-center gap-1.5 border-t border-border px-3 py-2'>
          {onSaveRecipe && (
            <button
              type='button'
              onClick={() => onSaveRecipe(picked.field, value)}
              data-tip='Save this update as a reusable recipe'
              className='h-8 rounded-md px-2.5 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
            >
              Save recipe
            </button>
          )}
          <span className='flex-1' />
          <button
            type='button'
            onClick={onCancel}
            className='h-8 rounded-md px-2.5 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
          >
            Cancel
          </button>
          <button
            type='button'
            disabled={picked.writable === 0}
            onClick={() => onApply(picked.field, value)}
            data-bulk-field-apply
            className='h-8 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-white transition-colors hover:bg-nvr-cyan/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 disabled:opacity-40'
          >
            Apply to {picked.writable}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className='flex flex-col' data-bulk-field-picker>
      <div className='border-b border-border px-3 py-2.5'>
        <p className='text-[13px] font-semibold text-foreground'>
          Update a field on {total} record{total === 1 ? '' : 's'}
        </p>
        {subtitle ? (
          <p className='text-[11.5px] text-muted-foreground'>{subtitle}</p>
        ) : (
          <Skeleton className='mt-1 h-3 w-48' />
        )}
      </div>
      {report.isLoading ? (
        <div className='space-y-2 p-3' aria-busy='true'>
          <Skeleton className='h-3 w-20' />
          <Skeleton className='h-7 w-full' />
          <Skeleton className='h-7 w-full' />
          <Skeleton className='h-3 w-24' />
          <Skeleton className='h-7 w-full' />
        </div>
      ) : report.isError ? (
        <div className='space-y-2 px-3 py-4 text-[12.5px] text-muted-foreground'>
          <p>Could not read these records’ forms.</p>
          <button
            type='button'
            onClick={() => void report.refetch()}
            className='h-7 rounded-md border border-border px-2.5 text-[12px] font-medium text-foreground hover:bg-muted'
          >
            Try again
          </button>
        </div>
      ) : sections.length === 0 ? (
        <p className='px-3 py-5 text-[12.5px] leading-5 text-muted-foreground'>
          {total === 0
            ? 'You cannot open any of the selected records.'
            : 'Their form has no field you can change in bulk. Open a record to edit it there.'}
        </p>
      ) : (
        <Command className='rounded-none bg-transparent'>
          <CommandInput placeholder='Find a field…' className='h-9 text-[13px]' />
          <CommandList className='max-h-[320px]'>
            <CommandEmpty className='py-5 text-center text-[12.5px] text-muted-foreground'>
              No field on the form matches.
            </CommandEmpty>
            {sections.map((s) => (
              <CommandGroup key={s.key} heading={s.label}>
                {s.options.map((o) => {
                  const blocked = o.writable === 0
                  const note = bulkFieldNote(o, total)
                  return (
                    <CommandItem
                      key={o.field}
                      value={`${s.label} ${o.label} ${o.field}`}
                      disabled={blocked}
                      onSelect={() => {
                        setPicked(o)
                        setValue(null)
                      }}
                      data-bulk-field-option={o.field}
                      className='items-start py-1.5 text-[13px] data-[disabled=true]:opacity-100'
                    >
                      <span className='min-w-0 flex-1'>
                        <span
                          className={cn(
                            'block truncate',
                            blocked ? 'text-muted-foreground' : 'text-foreground'
                          )}
                        >
                          {o.label}
                        </span>
                        {note && (
                          <span
                            className={cn(
                              'block truncate text-[11px] leading-4',
                              blocked
                                ? 'text-muted-foreground'
                                : 'text-amber-700 dark:text-amber-300'
                            )}
                          >
                            {note.charAt(0).toUpperCase() + note.slice(1)}
                          </span>
                        )}
                      </span>
                      {blocked && (
                        <Lock
                          className='mt-0.5 h-3.5 w-3.5 text-muted-foreground'
                          aria-label='Locked'
                        />
                      )}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      )}
      {report.data?.capped && (
        <p className='border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground'>
          Checked the first 1,000 selected records.
        </p>
      )}
    </div>
  )
}
