import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { invalidateRecordTasks } from '../../lib/record-tasks'
import { sendChangeRequest } from '../layout-editor/ops/ops-api'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { SimpleSelect } from '../ui/SimpleSelect'

/**
 * "Suggest a form change" (#2609): someone who cannot edit layouts tells the
 * administrators what should change about the FORM (not this record's data),
 * optionally naming a field. It lands as a "Form change" support request —
 * followed under My requests — and in the layout editor's suggested changes
 * for the form this record opened with. An anchored popover beside the
 * record's More button (the helper-surface rule), not a centred dialog.
 */
export function SuggestFormChange({
  open,
  onOpenChange,
  anchor,
  collection,
  item,
  layoutId,
  layoutName,
  fields,
  onSent
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What the popover sits beside: the More button the row was picked from. */
  anchor: HTMLElement | null
  collection: string
  item: string
  /** The layout this record page shows. */
  layoutId: number | null
  layoutName?: string | null
  /** Fields on the form, for "which field" (optional). */
  fields: Array<{ field: string; label: string }>
  onSent?: (r: { id: number }) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [field, setField] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setField('')
    setMessage('')
    setError(null)
  }

  const send = useMutation({
    mutationFn: () =>
      sendChangeRequest(client, {
        collection,
        item,
        layout_id: layoutId,
        field: field || null,
        field_label: fields.find((f) => f.field === field)?.label ?? null,
        message: message.trim()
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['support-tickets'] })
      void qc.invalidateQueries({ queryKey: ['support-summary'] })
      invalidateRecordTasks(qc, collection, item)
      onSent?.(r)
      reset()
      onOpenChange(false)
    },
    onError: (e) => setError((e as Error).message || 'Could not send the suggestion')
  })

  const canSend = message.trim().length > 0 && !send.isPending
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor])
  // Nothing in the record page's DOM until it is asked for.
  if (!open) return null
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <PopoverAnchor virtualRef={anchorRef as { current: HTMLElement }} />
      <PopoverContent
        align='end'
        role='dialog'
        aria-label='Suggest a form change'
        className='max-h-[min(80vh,620px)] w-[400px] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain p-0'
        data-suggest-form-change
      >
        <div className='px-4 pt-3.5'>
          <p className='text-[13.5px] font-semibold text-slate-900 dark:text-slate-100'>
            Suggest a form change
          </p>
          <p className='mt-0.5 text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
            Tell the administrators how this form{layoutName ? ` (${layoutName})` : ''} could work
            better — a field to add, move, rename or explain. You can follow it under My requests.
          </p>
        </div>
        <form
          className='space-y-3 px-4 pb-4 pt-3'
          onSubmit={(e) => {
            e.preventDefault()
            if (canSend) send.mutate()
          }}
        >
          {fields.length > 0 && (
            <div>
              <span className='mb-1 block text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                About a field (optional)
              </span>
              <SimpleSelect
                ariaLabel='Field'
                value={field}
                onChange={setField}
                options={[
                  { value: '', label: 'The form in general' },
                  ...fields.map((f) => ({ value: f.field, label: f.label }))
                ]}
                className='h-8 w-full text-[12.5px]'
                triggerProps={{ 'data-suggest-field': '' }}
              />
            </div>
          )}
          <label className='block'>
            <span className='mb-1 block text-[12px] font-medium text-slate-700 dark:text-slate-200'>
              What should change?
            </span>
            <textarea
              data-suggest-message
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder='e.g. Put Vendor next to PO number — we always check them together'
              className='w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-900 outline-none focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-100'
            />
          </label>
          {error && (
            <p className='text-[12px] text-red-600 dark:text-red-400' role='alert'>
              {error}
            </p>
          )}
          <div className='flex justify-end gap-2 pt-1'>
            <button
              type='button'
              onClick={() => onOpenChange(false)}
              className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] text-slate-700 hover:bg-slate-50 dark:border-border dark:text-slate-200 dark:hover:bg-white/5'
            >
              Cancel
            </button>
            <button
              type='submit'
              data-suggest-send
              disabled={!canSend}
              className='inline-flex h-8 items-center gap-1.5 rounded-md border border-nvr-cyan/60 bg-nvr-cyan/10 px-3 text-[12.5px] font-medium text-nvr-navy hover:bg-nvr-cyan/15 disabled:opacity-50 dark:text-nvr-cyan'
            >
              {send.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
              Send suggestion
            </button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
