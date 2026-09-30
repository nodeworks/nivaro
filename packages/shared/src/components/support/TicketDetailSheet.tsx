import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Paperclip } from 'lucide-react'
import { useState } from 'react'
import { useApiFetchConfig, useItemNavigation, useNivaroClient } from '../../context'
import { get, patch, post } from '../../lib/commands'
import { RelationCombobox } from '../item-edit/RelationCombobox'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet'
import {
  STATUS_TONE,
  type SupportCategory,
  type SupportTicketDetail,
  type TicketStatus
} from './types'

const STATUS_OPTIONS: Array<{ value: TicketStatus; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' }
]

function when(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function StatusPill({ status, label }: { status: TicketStatus; label?: string }) {
  return (
    <span
      data-ticket-status={status}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[status] ?? STATUS_TONE.open}`}
    >
      {label ?? STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status}
    </span>
  )
}

/**
 * One support ticket (#999): what was asked, the thread, the history, and —
 * for whoever works it — claim, status, type and assignee.
 */
export function TicketDetailSheet({
  ticketId,
  onOpenChange
}: {
  ticketId: number | null
  onOpenChange: (open: boolean) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { apiBase } = useApiFetchConfig()
  const { urlFor, open: openItem } = useItemNavigation()
  const [reply, setReply] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const { data: t, isLoading } = useQuery({
    queryKey: ['support-ticket', ticketId],
    queryFn: () =>
      client
        .request<{ data: SupportTicketDetail }>(get(`/support/tickets/${ticketId}`))
        .then((r) => r.data),
    enabled: ticketId != null
  })
  const { data: categories = [] } = useQuery({
    queryKey: ['support-categories', 'all-for', t?.collection ?? null],
    queryFn: () =>
      client
        .request<{ data: SupportCategory[] }>(
          get('/support/categories', t?.collection ? { collection: t.collection } : undefined)
        )
        .then((r) => r.data ?? []),
    enabled: !!t?.can.work
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['support-ticket', ticketId] })
    void qc.invalidateQueries({ queryKey: ['support-tickets'] })
    void qc.invalidateQueries({ queryKey: ['support-summary'] })
    void qc.invalidateQueries({ queryKey: ['my-work'] })
  }
  const onError = (e: unknown) => setErr((e as Error).message || 'That did not work')

  const claim = useMutation({
    mutationFn: () => client.request(post(`/support/tickets/${ticketId}/claim`)),
    onSuccess: refresh,
    onError
  })
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      client.request(patch(`/support/tickets/${ticketId}`, body)),
    onSuccess: refresh,
    onError
  })
  const send = useMutation({
    mutationFn: () =>
      client.request(post(`/support/tickets/${ticketId}/comments`, { text: reply.trim() })),
    onSuccess: () => {
      setReply('')
      refresh()
    },
    onError
  })

  return (
    <Sheet open={ticketId != null} onOpenChange={onOpenChange}>
      <SheetContent
        side='right'
        className='flex w-[560px] max-w-[96vw] flex-col gap-0 p-0 sm:max-w-[560px] dark:bg-card'
        data-support-ticket={ticketId ?? ''}
      >
        {isLoading || !t ? (
          <div className='flex flex-1 items-center justify-center text-slate-400'>
            <Loader2 className='h-5 w-5 animate-spin' />
          </div>
        ) : (
          <>
            <SheetHeader className='border-b border-slate-200 px-5 py-4 dark:border-border'>
              <div className='flex items-center gap-2 pr-6'>
                <span className='font-mono text-[11.5px] text-slate-400'>#{t.id}</span>
                <StatusPill status={t.status} label={t.status_label} />
                {t.priority === 'urgent' && (
                  <span className='rounded bg-red-500/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400'>
                    urgent
                  </span>
                )}
              </div>
              <SheetTitle className='mt-1 text-left text-[16px] font-semibold text-slate-900 dark:text-slate-100'>
                {t.title}
              </SheetTitle>
              <SheetDescription className='text-left text-[12px] text-slate-500 dark:text-muted-foreground'>
                {t.requester_name ?? 'Someone'} · {when(t.created_at)}
                {t.category_name ? ` · ${t.category_name}` : ''}
              </SheetDescription>
              <div className='mt-1 text-[12px]'>
                {t.collection && t.item ? (
                  <a
                    href={urlFor({ collection: t.collection, itemId: t.item })}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                      e.preventDefault()
                      openItem({ collection: t.collection as string, itemId: t.item as string })
                    }}
                    data-ticket-record
                    className='font-medium text-[#00789a] hover:underline dark:text-nvr-cyan'
                  >
                    {t.record_label ?? t.item}
                  </a>
                ) : (
                  <span className='text-slate-500 dark:text-muted-foreground'>General Support</span>
                )}
              </div>
            </SheetHeader>

            <div className='flex-1 space-y-5 overflow-y-auto px-5 py-4'>
              {t.can.work && (
                <div
                  data-ticket-controls
                  className='grid grid-cols-2 gap-3 rounded-lg border border-slate-200 p-3 dark:border-border'
                >
                  <div className='col-span-2 flex items-center justify-between gap-2'>
                    <span className='text-[12px] text-slate-600 dark:text-slate-300'>
                      {t.assignee_name ? (
                        <>
                          Assigned to <b className='font-medium'>{t.assignee_name}</b>
                        </>
                      ) : (
                        <>
                          Not picked up yet{t.team_name ? ` · ${t.team_name}` : ' · Administrators'}
                        </>
                      )}
                    </span>
                    {(t.status === 'open' || t.status === 'in_progress') && (
                      <button
                        type='button'
                        data-ticket-claim
                        disabled={claim.isPending}
                        onClick={() => claim.mutate()}
                        className='h-7 rounded-md border border-nvr-cyan/60 bg-nvr-cyan/10 px-2.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/15 disabled:opacity-50 dark:text-nvr-cyan'
                      >
                        {t.assignee ? 'Take it over' : 'Pick it up'}
                      </button>
                    )}
                  </div>
                  <div className='block text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
                    Status
                    <SimpleSelect
                      value={t.status}
                      onChange={(v) => update.mutate({ status: v })}
                      options={STATUS_OPTIONS}
                      ariaLabel='Status'
                      className='mt-1'
                    />
                  </div>
                  <div className='block text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
                    Type
                    <SimpleSelect
                      value={t.category_id != null ? String(t.category_id) : ''}
                      onChange={(v) => update.mutate({ category_id: v ? Number(v) : null })}
                      options={[
                        { value: '', label: 'No type' },
                        ...categories.map((c) => ({ value: String(c.id), label: c.name }))
                      ]}
                      ariaLabel='Type'
                      className='mt-1'
                    />
                  </div>
                  <div className='col-span-2 text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
                    Assignee
                    <div className='mt-1'>
                      <RelationCombobox
                        collection='nivaro_users'
                        value={t.assignee}
                        onChange={(v) => update.mutate({ assignee: v ? String(v) : null })}
                        placeholder='Nobody yet'
                      />
                    </div>
                  </div>
                </div>
              )}

              <section>
                <h3 className='mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
                  Request
                </h3>
                <p className='whitespace-pre-wrap text-[13px] leading-relaxed text-slate-800 dark:text-slate-200'>
                  {t.description || <span className='text-slate-400'>No details given.</span>}
                </p>
                {t.files.length > 0 && (
                  <ul className='mt-2 flex flex-wrap gap-1.5'>
                    {t.files.map((f) => (
                      <li key={f.id}>
                        <a
                          href={`${apiBase}/files/${f.id}`}
                          target='_blank'
                          rel='noreferrer'
                          className='inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-[11.5px] text-slate-700 hover:underline dark:bg-white/10 dark:text-slate-200'
                        >
                          <Paperclip className='h-3 w-3' />
                          {f.title || f.filename_download || 'File'}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section data-ticket-thread>
                <h3 className='mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
                  Conversation
                </h3>
                {t.thread.length === 0 ? (
                  <p className='text-[12px] text-slate-400'>No replies yet.</p>
                ) : (
                  <ul className='space-y-2.5'>
                    {t.thread.map((c) => (
                      <li
                        key={c.id}
                        className={
                          c.from_requester
                            ? 'rounded-lg bg-slate-50 px-3 py-2 dark:bg-white/5'
                            : 'rounded-lg border border-nvr-cyan/30 bg-nvr-cyan/5 px-3 py-2'
                        }
                      >
                        <div className='mb-0.5 flex items-baseline justify-between gap-2 text-[11.5px]'>
                          <b className='font-medium text-slate-800 dark:text-slate-100'>
                            {c.user_name ?? 'Someone'}
                          </b>
                          <span className='text-slate-400'>{when(c.created_at)}</span>
                        </div>
                        <p className='whitespace-pre-wrap text-[12.5px] text-slate-700 dark:text-slate-200'>
                          {c.text}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {t.can.reply && (
                  <form
                    className='mt-3'
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (reply.trim()) send.mutate()
                    }}
                  >
                    <textarea
                      data-ticket-reply
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      rows={3}
                      placeholder='Write a reply'
                      className='w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-[12.5px] text-slate-900 outline-none focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-100'
                    />
                    <div className='mt-1.5 flex items-center justify-end gap-2'>
                      {t.can.cancel && !t.can.work && (
                        <button
                          type='button'
                          data-ticket-cancel
                          onClick={() => update.mutate({ status: 'cancelled' })}
                          className='h-7 rounded-md px-2.5 text-[12px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-100'
                        >
                          Withdraw request
                        </button>
                      )}
                      {t.can.reopen && (
                        <button
                          type='button'
                          data-ticket-reopen
                          onClick={() => update.mutate({ status: 'open' })}
                          className='h-7 rounded-md px-2.5 text-[12px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-100'
                        >
                          Reopen
                        </button>
                      )}
                      <button
                        type='submit'
                        data-ticket-send
                        disabled={!reply.trim() || send.isPending}
                        className='h-7 rounded-md border border-nvr-cyan/60 bg-nvr-cyan/10 px-2.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/15 disabled:opacity-50 dark:text-nvr-cyan'
                      >
                        Reply
                      </button>
                    </div>
                  </form>
                )}
                {err && (
                  <p className='mt-1 text-[12px] text-red-600 dark:text-red-400' role='alert'>
                    {err}
                  </p>
                )}
              </section>

              <section data-ticket-history>
                <h3 className='mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
                  History
                </h3>
                <ol className='space-y-1.5 border-l border-slate-200 pl-3 dark:border-border'>
                  {t.history.map((h) => (
                    <li key={h.id} className='text-[12px] text-slate-600 dark:text-slate-300'>
                      <span className='text-slate-800 dark:text-slate-100'>{h.text}</span>
                      <span className='text-slate-400'>
                        {' '}
                        · {h.user_name ?? 'System'} · {when(h.at)}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
