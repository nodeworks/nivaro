import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../context'
import { del, get, patch, post } from '../lib/commands'
import { cn } from '../lib/utils'
import { PickList } from './imports/ServiceConfigBuilder'

/**
 * Broadcasts — compose + history for admin messages to a chosen audience
 * over any mix of channels (banner, in-app message, email, SMS when
 * configured). Embeddable: admin hosts it at /announcements, a headless
 * frontend mounts it inside a NivaroProvider (this is the Bulk Message page
 * grown up — zones targeting included via scope dimensions).
 */

interface ScopeDimension {
  id: number
  name: string
  label: string
  target_collection: string
  display_field: string | null
}

interface Broadcast {
  id: number
  subject: string | null
  message: string
  severity: 'info' | 'warn' | 'critical'
  channels: string[]
  audience: {
    roles?: string[]
    dimension?: string
    values?: Array<string | number>
    user_ids?: string[]
  } | null
  delivered_count: number | null
  is_active: boolean
  ends_at: string | null
  created_at: string | null
  ack_count: number
}

const SEVERITY_DOT: Record<string, string> = {
  info: 'bg-sky-500',
  warn: 'bg-amber-500',
  critical: 'bg-red-500'
}

export function BroadcastView({ className }: { className?: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()

  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [severity, setSeverity] = useState<'info' | 'warn' | 'critical'>('info')
  // Channels
  const [email, setEmail] = useState(false)
  const [sms, setSms] = useState(false)
  const [inApp, setInApp] = useState(true)
  const [inAppKind, setInAppKind] = useState<'banner' | 'message'>('banner')
  const [endsAt, setEndsAt] = useState('')
  // Audience
  const [dimension, setDimension] = useState('')
  const [dimValues, setDimValues] = useState<Array<string | number>>([])
  const [roleIds, setRoleIds] = useState<string[]>([])
  const [result, setResult] = useState<string | null>(null)

  const { data: config } = useQuery<{ sms_enabled: boolean }>({
    queryKey: ['broadcast-config'],
    queryFn: () =>
      client
        .request<{ data: { sms_enabled: boolean } }>(get('/announcements/config'))
        .then((r) => r.data)
        .catch(() => ({ sms_enabled: false })),
    staleTime: 5 * 60_000
  })

  const { data: dimensions = [] } = useQuery<ScopeDimension[]>({
    queryKey: ['broadcast-dimensions'],
    queryFn: () =>
      client
        .request<{ data: ScopeDimension[] }>(get('/scope-dimensions'))
        .then((r) => r.data ?? [])
        .catch(() => []),
    staleTime: 5 * 60_000
  })
  const dim = dimensions.find((d) => d.name === dimension)

  const { data: dimOptions = [] } = useQuery<Array<{ id: string | number; label: string }>>({
    queryKey: ['broadcast-dim-options', dim?.target_collection ?? null],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${dim?.target_collection}`, { limit: 200 })
        )
        .then((r) =>
          (r.data ?? []).map((row) => ({
            id: row.id as string | number,
            label: String(row[dim?.display_field || 'name'] ?? row.id)
          }))
        ),
    enabled: !!dim,
    staleTime: 5 * 60_000
  })

  const { data: roles = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['broadcast-roles'],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: string; name: string }> }>(get('/chat/roles'))
        .then((r) => r.data ?? [])
        .catch(() => []),
    staleTime: 5 * 60_000
  })

  const { data: history = [] } = useQuery<Broadcast[]>({
    queryKey: ['broadcasts'],
    queryFn: () =>
      client.request<{ data: Broadcast[] }>(get('/announcements')).then((r) => r.data ?? [])
  })

  const channels = useMemo(() => {
    const out: string[] = []
    if (inApp) out.push(inAppKind)
    if (email) out.push('email')
    if (sms) out.push('sms')
    return out
  }, [inApp, inAppKind, email, sms])

  const audienceSummary = useMemo(() => {
    const parts: string[] = []
    if (dimension && dimValues.length > 0) {
      const labels = dimValues.map(
        (v) => dimOptions.find((o) => String(o.id) === String(v))?.label ?? String(v)
      )
      parts.push(`${dim?.label ?? dimension}: ${labels.join(', ')}`)
    }
    if (roleIds.length > 0) {
      parts.push(`roles: ${roleIds.map((r) => roles.find((x) => x.id === r)?.name ?? r).join(', ')}`)
    }
    return parts.length > 0 ? parts.join(' · ') : 'Everyone'
  }, [dimension, dimValues, roleIds, dim, dimOptions, roles])

  const send = useMutation({
    mutationFn: () =>
      client.request<{ data: { id: number; delivered: number } }>(
        post('/announcements', {
          subject: subject.trim() || undefined,
          message: message.trim(),
          severity,
          channels,
          ends_at: endsAt || undefined,
          audience: {
            ...(dimension && dimValues.length > 0 ? { dimension, values: dimValues } : {}),
            ...(roleIds.length > 0 ? { roles: roleIds } : {})
          }
        })
      ),
    onSuccess: (r) => {
      setResult(
        channels.some((c) => c !== 'banner')
          ? `Sent — reached ${r.data.delivered} recipient(s).`
          : 'Banner published.'
      )
      setMessage('')
      setSubject('')
      void qc.invalidateQueries({ queryKey: ['broadcasts'] })
      void qc.invalidateQueries({ queryKey: ['announcements-active'] })
    },
    onError: (err: Error) => setResult(err.message)
  })

  const canSend = message.trim().length > 0 && channels.length > 0 && !send.isPending

  const patchRow = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      client.request(patch(`/announcements/${id}`, body)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['broadcasts'] })
      void qc.invalidateQueries({ queryKey: ['announcements-active'] })
    }
  })
  const removeRow = useMutation({
    mutationFn: (id: number) => client.request(del(`/announcements/${id}`)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['broadcasts'] })
      void qc.invalidateQueries({ queryKey: ['announcements-active'] })
    }
  })

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6', className)}>
      {/* ── Audience ───────────────────────────────────────────────────── */}
      <div className='max-w-[760px] rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>Audience</p>
        <p className='mt-0.5 text-[11.5px] text-slate-400'>
          No selection = everyone. Zone/role targeting narrows both send channels and who sees a
          banner.
        </p>
        <div className='mt-3 flex flex-wrap items-start gap-4'>
          <div className='w-[200px]'>
            <p className='mb-1 text-[11.5px] font-medium text-slate-700 dark:text-foreground'>
              By scope
            </p>
            <PickList
              value={dimension}
              onChange={(v) => {
                setDimension(v)
                setDimValues([])
              }}
              options={dimensions.map((d) => ({ value: d.name, label: d.label }))}
              placeholder='Any scope…'
              allowClear
            />
          </div>
          {dim && (
            <div className='min-w-[240px] flex-1'>
              <p className='mb-1 text-[11.5px] font-medium text-slate-700 dark:text-foreground'>
                {dim.label} values
              </p>
              <div className='flex flex-wrap gap-1.5'>
                {dimOptions.map((o) => {
                  const on = dimValues.some((v) => String(v) === String(o.id))
                  return (
                    <button
                      key={String(o.id)}
                      type='button'
                      onClick={() =>
                        setDimValues((prev) =>
                          on ? prev.filter((v) => String(v) !== String(o.id)) : [...prev, o.id]
                        )
                      }
                      className={cn(
                        'rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors',
                        on
                          ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                          : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-border dark:text-muted-foreground'
                      )}
                    >
                      {o.label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div className='min-w-[220px]'>
            <p className='mb-1 text-[11.5px] font-medium text-slate-700 dark:text-foreground'>
              By role
            </p>
            <div className='flex flex-wrap gap-1.5'>
              {roles.map((r) => {
                const on = roleIds.includes(r.id)
                return (
                  <button
                    key={r.id}
                    type='button'
                    onClick={() =>
                      setRoleIds((prev) => (on ? prev.filter((x) => x !== r.id) : [...prev, r.id]))
                    }
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors',
                      on
                        ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                        : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-border dark:text-muted-foreground'
                    )}
                  >
                    {r.name}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        <p className='mt-3 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          Sending to: <span className='font-medium'>{audienceSummary}</span>
        </p>
      </div>

      {/* ── Message + channels ─────────────────────────────────────────── */}
      <div className='max-w-[760px] rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>Message</p>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder='Subject…'
          className='mt-2 h-8 w-full rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] text-slate-800 dark:border-border dark:text-foreground'
        />
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          placeholder='Compose your message… (plain text; line breaks are kept)'
          className='mt-2 w-full rounded-md border border-slate-200 bg-background px-2.5 py-2 text-[12.5px] text-slate-800 dark:border-border dark:text-foreground'
        />
        <div className='mt-3 flex flex-wrap items-center gap-x-5 gap-y-2'>
          <label className='flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
            <input
              type='checkbox'
              checked={inApp}
              onChange={(e) => setInApp(e.target.checked)}
              className='h-3.5 w-3.5'
            />
            In-app
          </label>
          {inApp && (
            <span className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
              {(
                [
                  { value: 'banner', label: 'Banner' },
                  { value: 'message', label: 'Inbox message' }
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type='button'
                  onClick={() => setInAppKind(opt.value)}
                  className={cn(
                    'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                    inAppKind === opt.value
                      ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                      : 'text-slate-400 hover:text-slate-600'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </span>
          )}
          <label className='flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
            <input
              type='checkbox'
              checked={email}
              onChange={(e) => setEmail(e.target.checked)}
              className='h-3.5 w-3.5'
            />
            Email
          </label>
          {config?.sms_enabled && (
            <label className='flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
              <input
                type='checkbox'
                checked={sms}
                onChange={(e) => setSms(e.target.checked)}
                className='h-3.5 w-3.5'
              />
              Text (SMS)
            </label>
          )}
          {inApp && inAppKind === 'banner' && (
            <>
              <span className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
                {(['info', 'warn', 'critical'] as const).map((sv) => (
                  <button
                    key={sv}
                    type='button'
                    onClick={() => setSeverity(sv)}
                    className={cn(
                      'flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium capitalize transition-colors',
                      severity === sv
                        ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                        : 'text-slate-400 hover:text-slate-600'
                    )}
                  >
                    <span className={cn('h-1.5 w-1.5 rounded-full', SEVERITY_DOT[sv])} />
                    {sv}
                  </button>
                ))}
              </span>
              <label className='flex items-center gap-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                Ends
                <input
                  type='datetime-local'
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  className='h-7 rounded-md border border-slate-200 bg-background px-1.5 text-[12px] dark:border-border'
                />
              </label>
            </>
          )}
        </div>
        <div className='mt-4 flex items-center gap-3'>
          <button
            type='button'
            disabled={!canSend}
            onClick={() => {
              setResult(null)
              send.mutate()
            }}
            className='h-8 rounded-md bg-nvr-cyan px-4 text-[12.5px] font-medium text-white disabled:opacity-50'
          >
            {send.isPending ? 'Sending…' : 'Send'}
          </button>
          {!canSend && !send.isPending && (
            <span className='text-[11.5px] text-slate-400'>
              A message and at least one channel are required.
            </span>
          )}
          {result && (
            <span className='text-[12px] font-medium text-emerald-600 dark:text-emerald-400'>
              {result}
            </span>
          )}
        </div>
      </div>

      {/* ── History ────────────────────────────────────────────────────── */}
      <div className='max-w-[760px] space-y-2'>
        <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
          History
        </p>
        {history.length === 0 && (
          <p className='text-[12px] text-slate-400'>Nothing sent yet.</p>
        )}
        {history.map((a) => (
          <HistoryRow key={a.id} broadcast={a} onPatch={patchRow.mutate} onRemove={removeRow.mutate} />
        ))}
      </div>
    </div>
  )
}

/** One past broadcast, expandable into full receipts: banner dismissals
 *  (who saw it, when) and every send-channel outcome per user. */
function HistoryRow({
  broadcast: a,
  onPatch,
  onRemove
}: {
  broadcast: Broadcast
  onPatch: (v: { id: number; body: Record<string, unknown> }) => void
  onRemove: (id: number) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const { data: receipts } = useQuery<{
    acks: Array<{ acked_at: string | null; user_name: string | null; user_email: string | null }>
    deliveries: Array<{
      channel: string
      status: string
      delivered_at: string | null
      user_name: string | null
      user_email: string | null
    }>
  }>({
    queryKey: ['broadcast-receipts', a.id],
    queryFn: () =>
      client
        .request<{ data: never }>(get(`/announcements/${a.id}/receipts`))
        .then((r) => r.data),
    enabled: open,
    staleTime: 30_000
  })

  return (
    <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='flex items-start gap-3 px-4 py-3'>
        <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[a.severity])} />
        <div className='min-w-0 flex-1'>
          {a.subject && (
            <p className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
              {a.subject}
            </p>
          )}
          <p className='text-[12.5px] text-slate-600 dark:text-muted-foreground'>{a.message}</p>
          <p className='mt-0.5 text-[11px] text-slate-400'>
            {(a.channels ?? []).join(' + ')}
            {a.delivered_count != null && ` · reached ${a.delivered_count}`}
            {` · seen by ${a.ack_count}`}
            {a.created_at && ` · ${new Date(a.created_at).toLocaleString()}`}
            {' · '}
            <button
              type='button'
              onClick={() => setOpen((v) => !v)}
              className='underline decoration-dotted underline-offset-2 hover:text-slate-600 dark:hover:text-muted-foreground'
            >
              {open ? 'hide receipts' : 'who saw this?'}
            </button>
          </p>
        </div>
        {(a.channels ?? []).includes('banner') && (
          <button
            type='button'
            onClick={() => onPatch({ id: a.id, body: { is_active: !a.is_active } })}
            className={cn(
              'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium',
              a.is_active
                ? 'border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-400'
                : 'border-slate-200 text-slate-400 dark:border-border'
            )}
          >
            {a.is_active ? 'Live' : 'Off'}
          </button>
        )}
        <button
          type='button'
          onClick={() => onRemove(a.id)}
          className='shrink-0 text-[13px] text-slate-300 transition-colors hover:text-red-500'
        >
          ✕
        </button>
      </div>
      {open && (
        <div className='grid grid-cols-1 gap-4 border-t border-slate-100 px-4 py-3 dark:border-border sm:grid-cols-2'>
          <div>
            <p className='mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
              Seen (banner dismissed)
            </p>
            {!receipts && <p className='text-[11.5px] text-slate-400'>Loading…</p>}
            {receipts && receipts.acks.length === 0 && (
              <p className='text-[11.5px] text-slate-400'>Nobody has dismissed it yet.</p>
            )}
            {receipts?.acks.map((r, i) => (
              <p key={i} className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>
                {r.user_name || r.user_email || 'Unknown'}
                <span className='text-slate-400'>
                  {r.acked_at ? ` · ${new Date(r.acked_at).toLocaleString()}` : ''}
                </span>
              </p>
            ))}
          </div>
          <div>
            <p className='mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
              Deliveries
            </p>
            {!receipts && <p className='text-[11.5px] text-slate-400'>Loading…</p>}
            {receipts && receipts.deliveries.length === 0 && (
              <p className='text-[11.5px] text-slate-400'>
                Banner-only — no send channels on this broadcast.
              </p>
            )}
            {receipts?.deliveries.map((r, i) => (
              <p key={i} className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>
                {r.user_name || r.user_email || 'Unknown'}
                <span
                  className={cn(
                    'ml-1.5 rounded px-1 py-px text-[9.5px] font-medium uppercase',
                    r.status === 'sent'
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                      : r.status === 'failed'
                        ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                        : 'bg-slate-500/10 text-slate-500'
                  )}
                >
                  {r.channel} {r.status !== 'sent' ? r.status : ''}
                </span>
                <span className='text-slate-400'>
                  {r.delivered_at ? ` · ${new Date(r.delivered_at).toLocaleString()}` : ''}
                </span>
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
