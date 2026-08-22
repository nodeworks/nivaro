import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, RotateCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Outbound mail log (#71) — every send attempt with its outcome. Answers "did
 * the system email them?" from a table instead of a shrug. Detail sheet shows
 * the rendered body; failed/dropped rows can resend the stored html.
 */

interface MailRow {
  id: number
  to: string
  subject: string | null
  template: string | null
  status: 'sent' | 'failed' | 'dropped' | 'deferred'
  error: string | null
  created_at: string
}

const STATUS_STYLE: Record<string, string> = {
  sent: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
  dropped: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  deferred: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-400'
}

const STATUS_HINT: Record<string, string> = {
  sent: 'Delivered to the SMTP server',
  failed: 'The SMTP server rejected it — see the error',
  dropped: 'Test mode dropped it (recipient not on the allowlist)',
  deferred: 'Deferred into the recipient’s daily digest'
}

export default function MailLog() {
  const qc = useQueryClient()
  const [status, setStatus] = useState<string>('')
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [openId, setOpenId] = useState<number | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(input.trim())
      setPage(1)
    }, 400)
    return () => clearTimeout(t)
  }, [input])

  const { data } = useQuery<{ data: MailRow[]; total: number }>({
    queryKey: ['mail-log', status, search, page],
    queryFn: () =>
      api
        .get('/mail-log', { params: { status: status || undefined, search: search || undefined, page } })
        .then((r) => r.data)
  })
  const rows = data?.data ?? []
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / 50))

  const { data: detail } = useQuery<{
    data: MailRow & { body: string | null }
  }>({
    queryKey: ['mail-log-detail', openId],
    queryFn: () => api.get(`/mail-log/${openId}`).then((r) => r.data),
    enabled: openId != null
  })

  const resend = useMutation({
    mutationFn: (id: number) => api.post(`/mail-log/${id}/resend`),
    onSuccess: () => {
      toast.success('Resent — a new log row records the attempt')
      void qc.invalidateQueries({ queryKey: ['mail-log'] })
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Resend failed')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <Mail className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Mail Log
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Every outbound email attempt and its outcome — sent, failed, dropped by test mode,
              or deferred into a digest. Kept 30 days.
            </p>
          </div>
        </div>
        <div className='mt-3 flex items-center gap-2'>
          <div className='flex gap-1'>
            {['', 'sent', 'failed', 'dropped', 'deferred'].map((s) => (
              <button
                key={s || 'all'}
                type='button'
                onClick={() => {
                  setStatus(s)
                  setPage(1)
                }}
                className={cn(
                  'rounded-md px-3 py-1.5 text-[12.5px] font-medium capitalize',
                  status === s
                    ? 'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
                    : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-muted/50'
                )}
              >
                {s || 'All'}
              </button>
            ))}
          </div>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder='Search recipient or subject…'
            className='ml-auto h-8 w-[280px] rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] dark:border-border'
          />
        </div>
      </header>

      <div className='flex-1 overflow-y-auto p-6'>
        <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <table className='w-full text-[12px] tabular-nums'>
            <thead>
              <tr className='border-b border-slate-100 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border/60'>
                <th className='px-3 py-2 font-semibold'>When</th>
                <th className='px-3 py-2 font-semibold'>To</th>
                <th className='px-3 py-2 font-semibold'>Subject</th>
                <th className='px-3 py-2 font-semibold'>Template</th>
                <th className='px-3 py-2 font-semibold'>Status</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-50 dark:divide-border/40'>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className='px-3 py-8 text-center text-[13px] text-slate-400'>
                    No mail matches — sends land here the moment they happen.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setOpenId(r.id)}
                  className='cursor-pointer hover:bg-slate-50 dark:hover:bg-muted/40'
                >
                  <td className='whitespace-nowrap px-3 py-2 text-slate-500'>
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className='max-w-[240px] truncate px-3 py-2 font-medium text-slate-700 dark:text-foreground'>
                    {r.to}
                  </td>
                  <td className='max-w-[340px] truncate px-3 py-2 text-slate-600 dark:text-muted-foreground'>
                    {r.subject || '(no subject)'}
                  </td>
                  <td className='px-3 py-2 font-mono text-[11px] text-slate-400'>
                    {r.template || '—'}
                  </td>
                  <td className='px-3 py-2'>
                    <span
                      title={STATUS_HINT[r.status]}
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10.5px] font-semibold capitalize',
                        STATUS_STYLE[r.status] ?? 'bg-slate-100 text-slate-600'
                      )}
                    >
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className='mt-3 flex items-center gap-2 text-[12px] text-slate-500'>
            <button
              type='button'
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className='rounded-md border border-slate-200 px-2 py-1 disabled:opacity-40 dark:border-border'
            >
              Prev
            </button>
            <span>
              Page {page} of {pages} · {total.toLocaleString()} rows
            </span>
            <button
              type='button'
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
              className='rounded-md border border-slate-200 px-2 py-1 disabled:opacity-40 dark:border-border'
            >
              Next
            </button>
          </div>
        )}
      </div>

      {openId != null && (
        <div className='fixed inset-0 z-[60] flex justify-end bg-black/30' onClick={() => setOpenId(null)}>
          <div
            className='flex h-full w-[560px] flex-col overflow-hidden bg-white shadow-xl dark:bg-card'
            onClick={(e) => e.stopPropagation()}
          >
            <div className='flex items-start gap-3 border-b border-slate-200 px-5 py-4 dark:border-border'>
              <div className='min-w-0 flex-1'>
                <p className='truncate text-[14px] font-semibold text-slate-900 dark:text-foreground'>
                  {detail?.data.subject || '(no subject)'}
                </p>
                <p className='mt-0.5 truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
                  To {detail?.data.to} ·{' '}
                  {detail?.data.created_at && new Date(detail.data.created_at).toLocaleString()}
                </p>
              </div>
              {detail?.data && (
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold capitalize',
                    STATUS_STYLE[detail.data.status]
                  )}
                >
                  {detail.data.status}
                </span>
              )}
              <button
                type='button'
                onClick={() => setOpenId(null)}
                className='shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-muted'
              >
                <X className='h-4 w-4' />
              </button>
            </div>
            {detail?.data.error && (
              <div className='border-b border-red-100 bg-red-50 px-5 py-2.5 text-[12px] text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400'>
                {detail.data.error}
              </div>
            )}
            <div className='flex-1 overflow-y-auto bg-slate-50 p-4 dark:bg-background'>
              {detail?.data.body ? (
                <iframe
                  title='Rendered email'
                  sandbox=''
                  srcDoc={detail.data.body}
                  className='h-full min-h-[480px] w-full rounded-md border border-slate-200 bg-white dark:border-border'
                />
              ) : (
                <p className='text-[13px] text-slate-400'>No stored body for this send.</p>
              )}
            </div>
            <div className='border-t border-slate-200 px-5 py-3 dark:border-border'>
              <button
                type='button'
                disabled={resend.isPending || !detail?.data.body}
                onClick={() => detail && resend.mutate(detail.data.id)}
                className='flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-white disabled:opacity-50'
              >
                <RotateCw className='h-3.5 w-3.5' />
                Resend this email
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
