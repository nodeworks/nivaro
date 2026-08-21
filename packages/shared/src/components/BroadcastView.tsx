import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
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

/** One audience group: ANDed scope conditions; groups OR together. */
type AudienceGroup = Record<string, Array<string | number>>

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
  audience_summary?: string
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
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  // Audience
  const [groups, setGroups] = useState<AudienceGroup[]>([])
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

  const cleanGroups = useMemo(
    () =>
      groups
        .map((g) => {
          const out: AudienceGroup = {}
          for (const [k, v] of Object.entries(g)) if (k && v.length > 0) out[k] = v
          return out
        })
        .filter((g) => Object.keys(g).length > 0),
    [groups]
  )
  const fullAudience = useMemo(
    () => ({
      ...(cleanGroups.length > 0 ? { groups: cleanGroups } : {}),
      ...(roleIds.length > 0 ? { roles: roleIds } : {})
    }),
    [cleanGroups, roleIds]
  )

  const send = useMutation({
    mutationFn: () =>
      client.request<{ data: { id: number; delivered: number } }>(
        post('/announcements', {
          subject: subject.trim() || undefined,
          message: message.trim(),
          severity,
          channels,
          starts_at: startsAt || undefined,
          ends_at: endsAt || undefined,
          audience: fullAudience
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
        <div className='mt-3 space-y-2'>
          {groups.map((g, gi) => (
            <AudienceGroupCard
              key={gi}
              index={gi}
              group={g}
              dimensions={dimensions}
              onChange={(next) => setGroups((prev) => prev.map((x, i) => (i === gi ? next : x)))}
              onRemove={() => setGroups((prev) => prev.filter((_, i) => i !== gi))}
            />
          ))}
          <button
            type='button'
            onClick={() => setGroups((prev) => [...prev, {}])}
            className='rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-[11.5px] text-slate-500 hover:border-slate-400 hover:text-slate-700 dark:border-border dark:text-muted-foreground'
          >
            ＋ {groups.length === 0 ? 'Target by scope (e.g. Zone 2 + Node Splits)' : 'Add another group (OR)'}
          </button>
        </div>
        <div className='mt-3'>
          <p className='mb-1 text-[11.5px] font-medium text-slate-700 dark:text-foreground'>
            Limit to roles
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
        <div className='mt-3 border-t border-slate-100 pt-2.5 dark:border-border'>
          <AudiencePreviewChip
            audience={fullAudience}
            everyone={cleanGroups.length === 0 && roleIds.length === 0}
            label='Sending to'
          />
        </div>
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
                Starts
                <input
                  type='datetime-local'
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  className='h-7 rounded-md border border-slate-200 bg-background px-1.5 text-[12px] dark:border-border'
                />
              </label>
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
        {inApp && inAppKind === 'banner' && (
          <p className='mt-1.5 text-[11px] text-slate-400'>
            Starts/Ends control only the banner's visibility window: it appears at Starts (empty =
            right away) and auto-expires at Ends for everyone who hasn't dismissed it (empty = stays
            up until each person dismisses it, or you turn it Off in history). Email, text, and
            inbox messages always send once, immediately — the window doesn't delay them.
          </p>
        )}
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
          <p className='mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
            To: <span className='font-medium'>{a.audience_summary ?? 'Everyone'}</span>
          </p>
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

/** One audience group: ANDed scope conditions ("Zone 2 AND Node Splits"),
 *  with a live headcount resolved by the same code the send uses. */
function AudienceGroupCard({
  index,
  group,
  dimensions,
  onChange,
  onRemove
}: {
  index: number
  group: AudienceGroup
  dimensions: ScopeDimension[]
  onChange: (next: AudienceGroup) => void
  onRemove: () => void
}) {
  const usedDims = Object.keys(group)
  const unused = dimensions.filter((d) => !usedDims.includes(d.name))
  const complete = usedDims.length > 0 && usedDims.every((k) => (group[k] ?? []).length > 0)

  return (
    <div className='rounded-lg border border-slate-200 bg-slate-50/60 p-3 dark:border-border dark:bg-muted/30'>
      <div className='flex items-center justify-between'>
        <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
          Group {index + 1}
          {usedDims.length > 1 && ' · all conditions must match'}
        </p>
        <div className='flex items-center gap-2.5'>
          {complete && (
            <AudiencePreviewChip
              audience={{ groups: [group] }}
              everyone={false}
              label='Matches'
              compact
            />
          )}
          <button
            type='button'
            onClick={onRemove}
            className='text-[12px] text-slate-300 transition-colors hover:text-red-500'
          >
            ✕
          </button>
        </div>
      </div>
      <div className='mt-2 space-y-2'>
        {usedDims.map((dimName) => {
          const dim = dimensions.find((d) => d.name === dimName)
          return (
            <div key={dimName} className='flex flex-wrap items-start gap-2'>
              <span className='mt-0.5 w-[110px] shrink-0 text-[11.5px] font-medium text-slate-600 dark:text-muted-foreground'>
                {dim?.label ?? dimName}
              </span>
              <div className='min-w-0 flex-1'>
                {dim ? (
                  <DimValueChips
                    dim={dim}
                    selected={group[dimName] ?? []}
                    onChange={(vals) => {
                      const next = { ...group }
                      if (vals.length === 0) delete next[dimName]
                      else next[dimName] = vals
                      onChange(next)
                    }}
                  />
                ) : (
                  <span className='text-[11.5px] text-slate-400'>Unknown scope</span>
                )}
              </div>
            </div>
          )
        })}
        {unused.length > 0 && (
          <div className='w-[200px]'>
            <PickList
              value=''
              onChange={(v) => {
                if (v) onChange({ ...group, [v]: [] })
              }}
              options={unused.map((d) => ({ value: d.name, label: d.label }))}
              placeholder={usedDims.length === 0 ? 'Pick a scope…' : '＋ And also…'}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** Value toggles for one scope dimension, options from its target collection. */
function DimValueChips({
  dim,
  selected,
  onChange
}: {
  dim: ScopeDimension
  selected: Array<string | number>
  onChange: (vals: Array<string | number>) => void
}) {
  const client = useNivaroClient()
  const { data: options = [] } = useQuery<Array<{ id: string | number; label: string }>>({
    queryKey: ['broadcast-dim-options', dim.target_collection],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${dim.target_collection}`, { limit: 200 })
        )
        .then((r) =>
          (r.data ?? []).map((row) => ({
            id: row.id as string | number,
            label: String(row[dim.display_field || 'name'] ?? row.id)
          }))
        ),
    staleTime: 5 * 60_000
  })
  return (
    <div className='flex flex-wrap gap-1.5'>
      {options.length === 0 && <span className='text-[11.5px] text-slate-400'>Loading…</span>}
      {options.map((o) => {
        const on = selected.some((v) => String(v) === String(o.id))
        return (
          <button
            key={String(o.id)}
            type='button'
            onClick={() =>
              onChange(
                on ? selected.filter((v) => String(v) !== String(o.id)) : [...selected, o.id]
              )
            }
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors',
              on
                ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                : 'border-slate-200 bg-white text-slate-500 hover:text-slate-700 dark:border-border dark:bg-card dark:text-muted-foreground'
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Live "how many people, and who" — resolved by POST /preview-audience, the
 *  exact resolver the send uses (deduped across groups by construction).
 *  Clicking the count opens a searchable, alphabetical sidebar of everyone. */
function AudiencePreviewChip({
  audience,
  everyone,
  label,
  compact
}: {
  audience: Record<string, unknown>
  everyone: boolean
  label: string
  compact?: boolean
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const key = JSON.stringify(audience)
  const { data } = useQuery<{
    count: number
    users: Array<{ id: string; name: string; email: string | null }>
    truncated: boolean
  }>({
    queryKey: ['broadcast-audience-preview', key],
    queryFn: () =>
      client
        .request<{ data: never }>(post('/announcements/preview-audience', { audience }))
        .then((r) => r.data),
    enabled: !everyone,
    staleTime: 30_000
  })

  if (everyone) {
    return (
      <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        {label}: <span className='font-medium'>Everyone</span>
      </p>
    )
  }
  return (
    <>
      <button
        type='button'
        onClick={() => setOpen(true)}
        className='text-[11.5px] text-slate-500 underline decoration-dotted underline-offset-2 hover:text-slate-700 dark:text-muted-foreground'
        title='Click to see who'
      >
        {label}:{' '}
        <span className='font-medium'>
          {data ? `${data.count} user${data.count === 1 ? '' : 's'}` : '…'}
        </span>
        {!compact && data != null && data.count > 0 && ' (deduped across groups)'}
      </button>
      {open && data && (
        <AudienceUserSidebar
          title={label === 'Matches' ? 'This group matches' : 'Sending to'}
          count={data.count}
          users={data.users}
          truncated={data.truncated}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** Full-height right sidebar listing an audience: alphabetical, searchable. */
function AudienceUserSidebar({
  title,
  count,
  users,
  truncated,
  onClose
}: {
  title: string
  count: number
  users: Array<{ id: string; name: string; email: string | null }>
  truncated: boolean
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const q = search.trim().toLowerCase()
  const filtered = q
    ? users.filter(
        (u) => u.name.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q)
      )
    : users

  return createPortal(
    <div className='fixed inset-0 z-[100]'>
      <div className='absolute inset-0 bg-black/30' onClick={onClose} />
      <div className='absolute right-0 top-0 flex h-full w-[380px] max-w-[92vw] flex-col border-l border-slate-200 bg-white shadow-xl dark:border-border dark:bg-card'>
        <div className='shrink-0 border-b border-slate-100 px-4 py-3 dark:border-border'>
          <div className='flex items-center justify-between'>
            <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
              {title}
              <span className='ml-1.5 font-normal text-slate-400'>
                {count} user{count === 1 ? '' : 's'}
              </span>
            </p>
            <button
              type='button'
              onClick={onClose}
              className='text-[14px] text-slate-300 transition-colors hover:text-slate-600'
            >
              ✕
            </button>
          </div>
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search name or email…'
            className='mt-2 h-8 w-full rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] text-slate-800 dark:border-border dark:text-foreground'
          />
        </div>
        <div className='min-h-0 flex-1 overflow-y-auto px-4 py-2'>
          {filtered.length === 0 && (
            <p className='py-3 text-[12px] text-slate-400'>
              {users.length === 0 ? 'No one matches this yet.' : 'No matches for that search.'}
            </p>
          )}
          {filtered.map((u) => (
            <div
              key={u.id}
              className='border-b border-slate-50 py-1.5 last:border-0 dark:border-border/40'
            >
              <p className='text-[12.5px] text-slate-700 dark:text-foreground'>{u.name}</p>
              {u.email && <p className='text-[11px] text-slate-400'>{u.email}</p>}
            </div>
          ))}
          {truncated && (
            <p className='py-2 text-[11px] text-slate-400'>
              Showing the first {users.length} of {count}.
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
