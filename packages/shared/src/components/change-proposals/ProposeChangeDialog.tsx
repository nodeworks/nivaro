import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Loader2, Plus, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { describeError } from '../../lib/error-message'
import { cn } from '../../lib/utils'
import { RelationPicker } from '../layout-editor/pickers/relation-picker'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelect } from '../ui/SimpleSelect'
import { ProposalValue } from './ProposalValue'
import { type ProposableField, proposalsQueryKey } from './types'

const inputCls =
  'h-9 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-[13px] text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-nvr-cyan focus-visible:ring-2 focus-visible:ring-nvr-cyan/25'

/** The input one field takes in a proposal. Values stay as typed; the server reads them. */
function ProposalInput({
  field,
  value,
  onChange
}: {
  field: ProposableField
  value: unknown
  onChange: (v: unknown) => void
}) {
  const label = `New ${field.label}`
  switch (field.kind) {
    case 'relation':
      return field.relation ? (
        <RelationPicker
          relatedCollection={field.relation}
          value={value ?? null}
          onChange={(id) => onChange(id ?? null)}
          placeholder='Pick a record…'
        />
      ) : null
    case 'boolean':
      return (
        <fieldset
          aria-label={label}
          className='m-0 inline-flex h-9 min-w-0 items-center rounded-md border border-input bg-background p-0.5 text-[12.5px] font-medium'
        >
          {[
            { v: true, t: 'Yes' },
            { v: false, t: 'No' }
          ].map((o) => (
            <button
              key={o.t}
              type='button'
              aria-pressed={value === o.v}
              onClick={() => onChange(o.v)}
              className={cn(
                'inline-flex h-full items-center rounded px-3 transition-colors',
                value === o.v
                  ? 'bg-nvr-cyan text-white'
                  : 'text-slate-600 hover:bg-muted dark:text-slate-300'
              )}
            >
              {o.t}
            </button>
          ))}
        </fieldset>
      )
    case 'choice':
      return (
        <SimpleSelect
          ariaLabel={label}
          value={value == null ? '' : String(value)}
          onChange={(v) => onChange(v === '' ? null : v)}
          options={[
            { value: '', label: 'No value' },
            ...(field.choices ?? []).map((c) => ({ value: String(c.value), label: c.text }))
          ]}
          className='w-full'
        />
      )
    case 'textarea':
      return (
        <textarea
          aria-label={label}
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className={cn(inputCls, 'h-auto py-2 leading-snug')}
        />
      )
    case 'date':
      return (
        <input
          type='date'
          aria-label={label}
          value={value == null ? '' : String(value).slice(0, 10)}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
        />
      )
    case 'datetime':
      return (
        <input
          type='datetime-local'
          aria-label={label}
          value={value == null ? '' : String(value).slice(0, 16)}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
        />
      )
    case 'number':
      return (
        <input
          inputMode='decimal'
          aria-label={label}
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputCls, 'tabular-nums')}
        />
      )
    default:
      return (
        <input
          aria-label={label}
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
        />
      )
  }
}

/** A starting value for a field's input, from what the record holds now. */
function startValue(f: ProposableField): unknown {
  const v = f.current
  if (v == null) return f.kind === 'boolean' ? null : ''
  if (f.kind === 'date') return String(v).slice(0, 10)
  if (f.kind === 'datetime') {
    const d = new Date(String(v))
    if (Number.isNaN(d.getTime())) return ''
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return v
}

/** A typed value as sent: a local date-time goes out as an instant. */
function outgoing(f: ProposableField | undefined, v: unknown): unknown {
  if (v == null || v === '') return null
  if (f?.kind === 'datetime') {
    const d = new Date(String(v))
    return Number.isNaN(d.getTime()) ? v : d.toISOString()
  }
  return v
}

/**
 * Propose new values for a record locked after approval: pick the fields, type
 * the new value beside what it holds now, say why. The owners of the step see
 * it on the record and in My Work and accept or decline it.
 */
export function ProposeChangeDialog({
  open,
  onOpenChange,
  collection,
  item,
  recordLabel,
  step,
  fields
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  collection: string
  item: string
  recordLabel?: string | null
  step?: string | null
  fields: ProposableField[]
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [picked, setPicked] = useState<string[]>([])
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [reason, setReason] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sendingRef = useRef(false)
  const byName = useMemo(() => new Map(fields.map((f) => [f.field, f])), [fields])
  const addable = fields.filter((f) => !picked.includes(f.field))

  const reset = () => {
    setPicked([])
    setValues({})
    setReason('')
    setError(null)
    sendingRef.current = false
  }
  const add = (name: string) => {
    const f = byName.get(name)
    if (!f) return
    setPicked((p) => (p.includes(name) ? p : [...p, name]))
    setValues((v) => (name in v ? v : { ...v, [name]: startValue(f) }))
    setPickerOpen(false)
  }
  const remove = (name: string) => {
    setPicked((p) => p.filter((x) => x !== name))
    setValues((v) => {
      const { [name]: _gone, ...rest } = v
      return rest
    })
  }

  const send = useMutation({
    mutationFn: () =>
      client.request<{ data: { id: number } }>(
        post(`/change-proposals/record/${collection}/${encodeURIComponent(item)}`, {
          values: Object.fromEntries(picked.map((k) => [k, outgoing(byName.get(k), values[k])])),
          reason: reason.trim()
        })
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: proposalsQueryKey(collection, item) })
      toast.success('Proposal sent — the step’s owners will review it.')
      reset()
      onOpenChange(false)
    },
    onError: (err) => {
      sendingRef.current = false
      setError(describeError(err, 'Could not send the proposal').title)
    }
  })

  const canSend = picked.length > 0 && reason.trim().length >= 3 && !send.isPending

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className='max-w-2xl dark:bg-card' data-propose-change>
        <DialogHeader className='px-6 pt-5'>
          <DialogTitle className='text-[15px] font-semibold text-slate-900 dark:text-slate-100'>
            Propose a change{recordLabel ? ` · ${recordLabel}` : ''}
          </DialogTitle>
          <DialogDescription className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            {step
              ? `This record is at ${step}, so you can’t edit it directly. `
              : 'You can’t edit this record directly. '}
            Enter the new values and say why — the owners of the step accept or decline them.
          </DialogDescription>
        </DialogHeader>
        <form
          className='space-y-4 px-6 pb-5 pt-2'
          onSubmit={(e) => {
            e.preventDefault()
            if (!canSend || sendingRef.current) return
            sendingRef.current = true
            setError(null)
            send.mutate()
          }}
        >
          <div className='space-y-2' data-proposal-fields>
            {picked.length > 0 && (
              <ul className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border dark:border-border'>
                {picked.map((name) => {
                  const f = byName.get(name)
                  if (!f) return null
                  return (
                    <li key={name} data-proposal-field={name} className='px-3 py-2.5'>
                      <div className='mb-1.5 flex items-center justify-between gap-2'>
                        <span className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
                          {f.label}
                        </span>
                        <button
                          type='button'
                          aria-label={`Remove ${f.label}`}
                          onClick={() => remove(name)}
                          className='rounded p-1 text-slate-400 transition-colors hover:bg-muted hover:text-slate-700 dark:hover:text-slate-200'
                        >
                          <X className='h-3.5 w-3.5' />
                        </button>
                      </div>
                      <div className='grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)]'>
                        <div className='min-w-0 text-[12.5px] text-slate-500 dark:text-slate-400'>
                          <span className='mr-1.5 text-slate-400 dark:text-slate-500'>Now</span>
                          <ProposalValue
                            value={f.current}
                            kind={f.kind}
                            relation={f.relation}
                            choices={f.choices}
                          />
                        </div>
                        <ArrowRight
                          aria-hidden
                          className='hidden h-3.5 w-3.5 text-slate-400 sm:block'
                        />
                        <div className='min-w-0'>
                          <ProposalInput
                            field={f}
                            value={values[name]}
                            onChange={(v) => setValues((cur) => ({ ...cur, [name]: v }))}
                          />
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
            {addable.length > 0 && (
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  {picked.length === 0 ? (
                    <button
                      type='button'
                      data-proposal-add-field
                      className='flex w-full flex-col items-center gap-1 rounded-md border border-dashed border-slate-300 px-3 py-5 text-center transition-colors hover:border-nvr-cyan/60 hover:bg-nvr-cyan/5 dark:border-border'
                    >
                      <span className='inline-flex items-center gap-1.5 text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                        <Plus className='h-3.5 w-3.5' />
                        Pick a field to change
                      </span>
                      <span className='text-[12px] text-slate-500 dark:text-slate-400'>
                        Only the fields you could edit if the record were open are offered.
                      </span>
                    </button>
                  ) : (
                    <button
                      type='button'
                      data-proposal-add-field
                      className='inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-[#0e7490] transition-colors hover:bg-nvr-cyan/10 dark:text-[#67e8f9]'
                    >
                      <Plus className='h-3.5 w-3.5' />
                      Add another field
                    </button>
                  )}
                </PopoverTrigger>
                <PopoverContent className='w-72 p-0' align='start'>
                  <Command>
                    <CommandInput placeholder='Search fields…' />
                    <CommandList>
                      <CommandEmpty>No field matches.</CommandEmpty>
                      <CommandGroup>
                        {addable.map((f) => (
                          <CommandItem
                            key={f.field}
                            value={`${f.label} ${f.field}`}
                            onSelect={() => add(f.field)}
                          >
                            {f.label}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            )}
          </div>
          <label className='block'>
            <span className='mb-1 block text-[12px] font-medium text-slate-700 dark:text-slate-200'>
              Why is the change needed?
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={2000}
              data-proposal-reason
              placeholder='e.g. The vendor sent a revised quote on Nov 12.'
              className={cn(inputCls, 'h-auto py-2 leading-snug')}
            />
          </label>
          {error && (
            <p
              role='alert'
              className='rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
            >
              {error}
            </p>
          )}
          <div className='flex items-center justify-end gap-2 pt-1'>
            <button
              type='button'
              onClick={() => {
                reset()
                onOpenChange(false)
              }}
              className='h-9 rounded-md px-3 text-[13px] font-medium text-slate-600 transition-colors hover:bg-muted dark:text-slate-300'
            >
              Cancel
            </button>
            <button
              type='submit'
              disabled={!canSend}
              data-proposal-send
              className='inline-flex h-9 items-center gap-1.5 rounded-md bg-nvr-cyan px-4 text-[13px] font-semibold text-white shadow-sm transition-opacity disabled:opacity-50'
            >
              {send.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
              Send proposal
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
