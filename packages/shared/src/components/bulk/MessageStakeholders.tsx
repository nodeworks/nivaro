import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { userErrorMessage } from '../../lib/safe-error'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/** What the server messages at most per send (routes/notifications.ts message-stakeholders). */
export const MESSAGE_STAKEHOLDERS_MAX = 200

/**
 * Bulk-bar "Message…" (shared by the collection list and the worklist bar,
 * army 11 N11): notifies the selection's current pipeline owners and/or
 * creators, deduped server-side, with an optional email copy and a Critical
 * send. Permission is the collection's `message` built-in, judged by the
 * server; the server reads at most the first 200 records, said here.
 *
 * `layout`: 'inline' = one row inside the list's navy bar; 'stacked' = a
 * column inside the worklist bar's popover.
 */
export function MessageStakeholdersForm({
  collection,
  selectedIds,
  onDone,
  onCancel,
  layout = 'inline'
}: {
  collection: string
  selectedIds: Array<string | number>
  onDone: (msg: string) => void
  onCancel: () => void
  layout?: 'inline' | 'stacked'
}) {
  const client = useNivaroClient()
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [owners, setOwners] = useState(true)
  const [creators, setCreators] = useState(true)
  const [email, setEmail] = useState(false)
  // #64 — a critical send: Critical lane, bypasses mutes and quiet hours,
  // and the sender gets read receipts (Notifications → Sent).
  const [critical, setCritical] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ids = selectedIds.slice(0, MESSAGE_STAKEHOLDERS_MAX)
  const capped = selectedIds.length > MESSAGE_STAKEHOLDERS_MAX

  const { data: preview } = useQuery({
    queryKey: ['cbv-msg-preview', collection, ids.join(','), owners, creators],
    queryFn: () =>
      client.request<{ count: number; users: Array<{ id: string; name: string }> }>(
        post('/notifications/message-stakeholders', {
          collection,
          ids,
          include: { owners, creators },
          preview: true
        })
      ),
    enabled: owners || creators
  })
  const count = owners || creators ? (preview?.count ?? null) : 0

  const send = async () => {
    if (!subject.trim() || !message.trim()) return
    setBusy(true)
    setErr(null)
    try {
      const res = await client.request<{ sent: number; records: number }>(
        post('/notifications/message-stakeholders', {
          collection,
          ids,
          subject: critical ? `Critical: ${subject.trim()}` : subject.trim(),
          message: message.trim(),
          include: { owners, creators },
          email
        })
      )
      onDone(`Messaged ${res.sent} stakeholder(s) across ${res.records} record(s)`)
    } catch (e) {
      setErr(userErrorMessage(e, 'Failed to send'))
      setBusy(false)
    }
  }

  const stacked = layout === 'stacked'
  const labelCls = stacked
    ? 'flex cursor-pointer items-center gap-1.5 text-[12px] text-foreground'
    : 'flex cursor-pointer items-center gap-1 text-[12px] text-slate-300 dark:text-muted-foreground'
  const inputCls = stacked
    ? 'h-8 w-full rounded-md border border-input bg-background px-2 text-[12.5px] text-foreground placeholder:text-muted-foreground focus-visible:border-nvr-cyan focus-visible:outline-none'
    : 'h-8 rounded-md border border-white/20 dark:border-border bg-white/10 dark:bg-background px-2 text-[12.5px] text-white dark:text-foreground placeholder:text-slate-400 dark:placeholder:text-muted-foreground'
  const box = (
    checked: boolean,
    set: (v: boolean) => void,
    label: string,
    extra: Record<string, string> = {}
  ) => (
    <label className={labelCls} {...('tip' in extra ? { 'data-tip': extra.tip } : {})}>
      <input
        type='checkbox'
        checked={checked}
        onChange={(e) => set(e.target.checked)}
        className='h-3.5 w-3.5'
        {...('data' in extra ? { [extra.data]: '' } : {})}
      />
      {label}
    </label>
  )

  return (
    <form
      className={cn(stacked ? 'flex flex-col gap-2' : 'flex flex-wrap items-center gap-1.5')}
      data-message-stakeholders={layout}
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <div className={cn('flex flex-wrap items-center', stacked ? 'gap-x-3 gap-y-1' : 'gap-1.5')}>
        {box(owners, setOwners, 'Owners')}
        {box(creators, setCreators, 'Creators')}
        {box(email, setEmail, 'Also email')}
        {box(critical, setCritical, 'Critical', {
          tip: 'Marks the message critical: it lands in the Critical lane, gets past mutes and quiet hours, and you can see who has read it under Notifications → Sent.',
          data: 'data-msg-critical'
        })}
        <span
          className={cn('text-[11.5px]', stacked ? 'text-muted-foreground' : 'text-nvr-cyan')}
          data-tip={preview?.users?.map((u) => u.name).join(', ')}
        >
          {count == null ? '…' : `${count} recipient${count === 1 ? '' : 's'}`}
        </span>
      </div>
      {capped && (
        <p
          className={cn(
            'text-[11px]',
            stacked ? 'text-amber-700 dark:text-amber-300' : 'text-amber-200'
          )}
        >
          Messages the people on the first {MESSAGE_STAKEHOLDERS_MAX} of {selectedIds.length}{' '}
          records.
        </p>
      )}
      <input
        // biome-ignore lint/a11y/noAutofocus: the form just opened for this
        autoFocus
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder='Subject'
        aria-label='Subject'
        className={cn(inputCls, !stacked && 'w-44')}
      />
      {stacked ? (
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder='Message'
          aria-label='Message'
          rows={3}
          className={cn(inputCls, 'h-auto resize-none py-1.5')}
        />
      ) : (
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder='Message'
          aria-label='Message'
          className={cn(inputCls, 'w-64')}
        />
      )}
      {err && (
        <span className={cn('text-[11.5px]', stacked ? 'text-destructive' : 'text-red-300')}>
          {err}
        </span>
      )}
      <div className={cn('flex items-center gap-1.5', stacked && 'justify-end')}>
        {stacked && (
          <button
            type='button'
            onClick={onCancel}
            className='h-8 rounded-md px-2.5 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground'
          >
            Cancel
          </button>
        )}
        <button
          type='submit'
          disabled={busy || !subject.trim() || !message.trim() || count === 0}
          className={cn(
            'h-8 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold disabled:opacity-50',
            stacked ? 'text-white' : 'text-[#0f1e2d]'
          )}
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
        {!stacked && (
          <button
            type='button'
            onClick={onCancel}
            className='h-8 px-2 text-[12.5px] text-slate-300 dark:text-muted-foreground hover:text-white dark:hover:text-foreground'
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

/**
 * The worklist bar's "Message…" — the same form in a popover above the pill.
 * One collection at a time (the server judges the collection's built-in).
 */
export function BulkMessageButton({
  targets,
  disabled,
  className
}: {
  targets: Array<{ collection: string; id: string | number }>
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const collections = [...new Set(targets.map((t) => t.collection))]
  if (targets.length === 0) return null
  if (collections.length !== 1)
    return (
      <button
        type='button'
        disabled
        data-tip='Pick records of one kind to message their people together'
        className={className}
      >
        Message…
      </button>
    )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={disabled}
          className={className}
          data-bulk-message
          aria-haspopup='dialog'
        >
          Message…
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='center'
        sideOffset={8}
        className='w-[360px] max-w-[calc(100vw-24px)] p-3'
      >
        <p className='mb-2 text-[13px] font-semibold text-foreground'>
          Message the people on {targets.length} record{targets.length === 1 ? '' : 's'}
        </p>
        {open && (
          <MessageStakeholdersForm
            collection={collections[0]}
            selectedIds={targets.map((t) => t.id)}
            layout='stacked'
            onCancel={() => setOpen(false)}
            onDone={(msg) => {
              setOpen(false)
              toast.success(msg)
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}
