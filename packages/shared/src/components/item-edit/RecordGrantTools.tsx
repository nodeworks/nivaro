import type { Command as SdkCommand } from '@nivaro/sdk'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Check, ChevronsUpDown, EyeOff, Loader2 } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, titleCase } from '../../lib/utils'
import { Button } from '../ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

/**
 * "Disable in pickers" for one record — a More-menu row that takes the record
 * out of every relation picker (or puts it back). Shown when the form grants
 * it (allow_disable_pickers) or to administrators; the server checks the same
 * grant against the form this record opens with (`layoutSlug` = ?layout=).
 */
export function PickerExclusionToggle({
  collection,
  itemId,
  layoutSlug
}: {
  collection: string
  itemId: string
  layoutSlug?: string | null
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const key = ['picker-exclusion', collection, itemId]
  const { data } = useQuery({
    queryKey: key,
    queryFn: () =>
      client
        .request<{ data: { excluded: boolean } }>(
          get(`/picker-exclusions/status/${collection}/${itemId}`)
        )
        .then((r) => r.data),
    staleTime: 60_000
  })
  const excluded = data?.excluded ?? false
  const toggle = useMutation({
    mutationFn: () => {
      const body = { collection, item_id: itemId, layout: layoutSlug ?? null }
      return client.request(
        excluded
          ? ({ _method: 'DELETE', _path: '/picker-exclusions', _body: body } as SdkCommand<unknown>)
          : post('/picker-exclusions', body)
      )
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key })
      toast.success(excluded ? 'Record re-enabled in pickers' : 'Record excluded from pickers')
    },
    onError: (e) => toast.error(errorText(e, 'Could not change picker visibility'))
  })
  return (
    <button
      type='button'
      data-record-picker-exclusion
      data-excluded={excluded ? 'true' : 'false'}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate()}
      data-tip={
        excluded
          ? 'This record is hidden from pickers — click to offer it again'
          : 'Hide this record from every picker that would offer it'
      }
      className='inline-flex items-center'
    >
      {toggle.isPending ? <Loader2 className='animate-spin' /> : <EyeOff />}
      {excluded ? 'Re-enable in pickers' : 'Disable in pickers'}
    </button>
  )
}

export interface ScheduleFieldOption {
  field: string
  label?: string | null
}

/**
 * "Schedule a change" — a More-menu row whose popover queues one field value
 * to apply at a chosen time (POST /scheduled-changes). Shown when the form
 * grants it (allow_schedule) or to administrators; the server still requires
 * update permission on the collection.
 */
export function ScheduleChangeButton({
  collection,
  itemId,
  fields
}: {
  collection: string
  itemId: string
  fields: ScheduleFieldOption[]
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [field, setField] = useState('')
  const [value, setValue] = useState('')
  const [at, setAt] = useState('')
  const id = useId()
  const options = useMemo(
    () =>
      fields
        .filter((f) => !f.field.startsWith('__') && !f.field.includes('.'))
        .map((f) => ({ field: f.field, label: f.label || titleCase(f.field) })),
    [fields]
  )
  const picked = options.find((o) => o.field === field)
  const create = useMutation({
    mutationFn: () =>
      client.request(
        post('/scheduled-changes', {
          collection,
          item_id: itemId,
          change_type: 'field_update',
          changes: { [field]: value },
          // datetime-local is the viewer's local time; the API stores UTC.
          scheduled_at: new Date(at).toISOString()
        })
      ),
    onSuccess: () => {
      setOpen(false)
      setField('')
      setValue('')
      setAt('')
      toast.success('Change scheduled')
    },
    onError: (e) => toast.error(errorText(e, 'Could not schedule the change'))
  })
  const atValid = at !== '' && !Number.isNaN(new Date(at).getTime())
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-record-schedule-change
          data-tip='Set a field to a new value at a time you choose'
          className='inline-flex items-center'
        >
          <CalendarClock />
          Schedule a change…
        </button>
      </PopoverTrigger>
      <PopoverContent side='left' align='start' className='w-80 p-4' data-schedule-change-panel>
        <p className='mb-3 text-[13px] font-medium'>Schedule a field change</p>
        <div className='space-y-3'>
          <div>
            <span className='mb-1 block text-[11px] font-medium text-muted-foreground'>Field</span>
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  type='button'
                  variant='outline'
                  role='combobox'
                  aria-expanded={pickerOpen}
                  aria-label='Field'
                  className='h-8 w-full justify-between text-[12px] font-normal'
                >
                  <span className='truncate'>{picked?.label ?? 'Select a field…'}</span>
                  <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
                </Button>
              </PopoverTrigger>
              <PopoverContent className='w-[--radix-popover-trigger-width] p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search fields…' className='h-8 text-[12px]' />
                  <CommandList>
                    <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
                      No field matches
                    </CommandEmpty>
                    {options.map((o) => (
                      <CommandItem
                        key={o.field}
                        value={`${o.label} ${o.field}`}
                        onSelect={() => {
                          setField(o.field)
                          setPickerOpen(false)
                        }}
                        className='text-[12px]'
                      >
                        <Check
                          className={cn(
                            'mr-2 h-3.5 w-3.5',
                            field === o.field ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        <span className='truncate'>{o.label}</span>
                        <span className='ml-auto pl-2 text-[11px] text-muted-foreground'>
                          {o.field}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <div>
            <label
              htmlFor={`${id}-value`}
              className='mb-1 block text-[11px] font-medium text-muted-foreground'
            >
              New value
            </label>
            <Input
              id={`${id}-value`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className='h-8 text-[12px]'
            />
          </div>
          <div>
            <label
              htmlFor={`${id}-at`}
              className='mb-1 block text-[11px] font-medium text-muted-foreground'
            >
              When
            </label>
            <Input
              id={`${id}-at`}
              type='datetime-local'
              value={at}
              onChange={(e) => setAt(e.target.value)}
              className='h-8 text-[12px]'
            />
          </div>
          <Button
            type='button'
            size='sm'
            className='h-8 w-full bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
            disabled={!field || !value || !atValid || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Scheduling…' : 'Schedule change'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
