/**
 * Binding setting: who may create a record of the bound collection straight
 * into a later step (`$start_state` on REST, `start_state` on GraphQL —
 * api services/start-state.ts, migration 531). Administrators always may;
 * the roles listed here may too, limited to the steps listed (none = any).
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronsUpDown, Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/** A binding's JSON list column (or an array) as plain strings. */
export function parseStartList(value: unknown): string[] {
  let v = value
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return []
    try {
      v = JSON.parse(t)
    } catch {
      v = t.split(',')
    }
  }
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))]
}

interface Option {
  value: string
  label: string
  hint?: string
}

function ChipPicker({
  label,
  value,
  options,
  onChange,
  addLabel,
  findLabel,
  emptyText,
  noneText
}: {
  label: string
  value: string[]
  options: Option[]
  onChange: (next: string[]) => void
  addLabel: string
  findLabel: string
  emptyText: string
  noneText: string
}) {
  const [open, setOpen] = useState(false)
  const byValue = useMemo(() => new Map(options.map((o) => [o.value.toLowerCase(), o])), [options])
  const left = options.filter((o) => !value.some((v) => v.toLowerCase() === o.value.toLowerCase()))
  return (
    <fieldset
      className='m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0'
      aria-label={label}
    >
      {value.length === 0 && (
        <span className='text-[12px] text-slate-500 dark:text-slate-400'>{noneText}</span>
      )}
      {value.map((v) => {
        const o = byValue.get(v.toLowerCase())
        return (
          <span
            key={v}
            className='inline-flex h-6 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 pl-2 pr-1 text-[12px] text-slate-700 dark:border-border dark:bg-muted dark:text-slate-200'
          >
            <span className='max-w-[16rem] truncate'>{o?.label ?? v}</span>
            <button
              type='button'
              onClick={() => onChange(value.filter((x) => x !== v))}
              aria-label={`Remove ${o?.label ?? v}`}
              className='rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nvr-cyan dark:hover:bg-slate-700 dark:hover:text-white'
            >
              <X className='h-3 w-3' />
            </button>
          </span>
        )
      })}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            disabled={left.length === 0}
            className='inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 text-[12px] text-slate-600 hover:border-slate-400 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-border dark:text-slate-300 dark:hover:text-white'
          >
            <Plus className='h-3 w-3' /> {addLabel}
            <ChevronsUpDown className='h-3 w-3 opacity-60' />
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-64 p-0'>
          <Command>
            <CommandInput placeholder={findLabel} />
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {left.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={`${o.label} ${o.hint ?? ''} ${o.value}`}
                    onSelect={() => {
                      onChange([...value, o.value])
                      setOpen(false)
                    }}
                  >
                    <span className='truncate'>{o.label}</span>
                    {o.hint && (
                      <span className='ml-auto truncate font-mono text-[10.5px] text-slate-500 dark:text-slate-400'>
                        {o.hint}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </fieldset>
  )
}

export function BindingStartStateSettings({
  collection,
  roles: rolesValue,
  allowed: allowedValue,
  states,
  onSave
}: {
  collection: string
  roles: unknown
  allowed: unknown
  states: Array<{ id: string; key: string; label: string; is_initial?: boolean }>
  onSave: (body: { start_state_roles?: string[]; start_state_allowed?: string[] }) => void
}) {
  const client = useNivaroClient()
  const roles = parseStartList(rolesValue)
  const allowed = parseStartList(allowedValue)
  const { data: roleRows } = useQuery({
    queryKey: ['pipeline-start-state-roles'],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: string; name: string; admin_access?: boolean }> }>(
          get('/roles')
        )
        .then((r) => r.data)
        .catch(() => [] as Array<{ id: string; name: string; admin_access?: boolean }>),
    staleTime: 5 * 60_000
  })
  const roleOptions: Option[] = (roleRows ?? [])
    .filter((r) => !r.admin_access)
    .map((r) => ({ value: String(r.id), label: r.name }))
  const stateOptions: Option[] = states
    .filter((s) => !s.is_initial)
    .map((s) => ({ value: s.key, label: s.label, hint: s.key }))

  return (
    <div className='mt-3 space-y-2.5 border-t border-slate-100 pt-3 dark:border-border'>
      <div>
        <div className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
          Who may create records in a later step
        </div>
        <p className='mt-0.5 max-w-[72ch] text-[11.5px] text-slate-500 dark:text-slate-400'>
          An integration or person creating a {collection} record can name the step it starts in (
          <code className='font-mono'>start_state</code> in the API). Administrators always may. No
          transition runs, so its actions (partner pushes, emails set on the move) do not.
        </p>
        <div className='mt-1.5'>
          <ChipPicker
            label='Roles that may create records in a later step'
            value={roles}
            options={roleOptions}
            onChange={(next) => onSave({ start_state_roles: next })}
            addLabel='Add a role'
            findLabel='Find a role'
            emptyText='No role matches.'
            noneText='Administrators only'
          />
        </div>
      </div>
      {roles.length > 0 && (
        <div>
          <div className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
            Which steps
          </div>
          <p className='mt-0.5 max-w-[72ch] text-[11.5px] text-slate-500 dark:text-slate-400'>
            The steps those roles may start a record in. Leave empty to allow any step.
          </p>
          <div className='mt-1.5'>
            <ChipPicker
              label='Steps those roles may start a record in'
              value={allowed}
              options={stateOptions}
              onChange={(next) => onSave({ start_state_allowed: next })}
              addLabel='Add a step'
              findLabel='Find a step'
              emptyText='No step matches.'
              noneText='Any step'
            />
          </div>
        </div>
      )}
    </div>
  )
}
