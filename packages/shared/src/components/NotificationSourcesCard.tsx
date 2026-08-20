import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, BellRing, FileBarChart, Gauge, History, Inbox, Radar, X } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../context'
import { del, get, patch, put } from '../lib/commands'
import { formatRelative, titleCase } from '../lib/utils'
import { SimpleSelectXs } from './ui/SimpleSelect'

/**
 * "Where do all my emails/texts/notifications come from — and when did they
 * last fire?" The profile page's single answer, in two tabs:
 *
 * SOURCES — every subscription/alert in plain language, grouped, with inline
 * editing (digest cadence, delivery channels) through each feature's OWN
 * routes, two-step removal, and a last-fired stamp where the system records
 * one. Workflow-state subscriptions collapse into one chip group — eleven
 * near-identical rows taught nothing.
 *
 * HISTORY — the merged feed of what actually fired: in-app deliveries plus
 * metric/record/report alert log entries, newest first, grouped by day.
 *
 * Implicit sources (pipeline ownership, SLA escalations) are shown but not
 * removable — they follow from role, not subscription.
 */

interface SubRow {
  id: number
  collection: string | null
  event_type: string
  label: string | null
  is_active: boolean | number
  digest_frequency: string | null
  queue_id: string | null
  queue_name: string | null
  filter_field: string | null
  filter_value: string | null
  state_label?: string | null
  /** Server-resolved human filter criteria — "Zone: Zone 1", "Project type: Commercial". */
  criteria?: string[] | null
}

interface Sources {
  preferences: { email_digest: string }
  subscriptions: SubRow[]
  field_watches: Array<{
    id: number
    watch_id: number
    name: string
    collection: string
    field: string
  }>
  record_alerts: Array<{
    id: number
    definition_id: number
    name: string
    collection: string
    notify_email: boolean | number
    notify_inapp: boolean | number
    is_active: boolean | number
    last_fired?: string | null
  }>
  metric_alerts: Array<{
    id: number
    rule_id: number
    metric_key: string | null
    operator: string
    threshold_value: number
    rule_status: string
    delivery_in_app: boolean | number
    delivery_email: boolean | number
    digest_frequency: string | null
    last_notified?: string | null
  }>
  anomaly_rules: Array<{
    id: number
    name: string
    check_frequency: string
    delivery_in_app: boolean | number
    delivery_email: boolean | number
    status: string
  }>
  report_subscriptions: Array<{
    id: number
    report_id: string
    name: string
    cadence: string
    delivery_email: boolean | number
    delivery_inapp: boolean | number
    deliver_teams: boolean | number
    attach_pdf: boolean | number
    last_sent_at?: string | null
  }>
  report_alerts: Array<{
    id: string
    report_id: string
    report_name: string
    name: string
    delivery_email: boolean | number
    delivery_inapp: boolean | number
  }>
  view_subscriptions: Array<{
    id: number
    name: string
    collection: string
    digest: string
    is_active: boolean | number
    last_run_at?: string | null
  }>
  chat_rooms: Array<{ room: string; is_muted: boolean | number; notify_mode: string | null }>
  push_devices: Array<{ id: number; user_agent: string | null; last_used_at: string | null }>
  implicit: {
    owner_group_memberships: Array<{ template: string; groups: number }>
    sla_escalations: Array<{ id: number; name: string; state_key: string; template: string | null }>
  }
}

interface HistoryEntry {
  kind: string
  at: string
  title: string
  detail: string | null
  collection?: string | null
  item?: string | null
  status?: string | null
  channels?: string[]
}

const OP_WORDS: Record<string, string> = {
  gt: 'goes above',
  gte: 'reaches',
  lt: 'drops below',
  lte: 'falls to',
  eq: 'equals',
  change_pct: 'changes by'
}

/** "workflows.on_hold_count" → "Workflows · on hold count". */
function humanMetric(key: string | null): string {
  if (!key) return 'Metric'
  const [head, ...rest] = key.split('.')
  const tail = rest.join(' ').replace(/_/g, ' ')
  return tail ? `${titleCase(head)} · ${tail}` : titleCase(head.replace(/_/g, ' '))
}

/** "Email + in-app, instantly" — one readable sentence, never bare chips. */
function deliveryPhrase(email: boolean, inApp: boolean, cadence?: string | null): string {
  const channels =
    email && inApp ? 'Email + in-app' : email ? 'Email' : inApp ? 'In-app' : 'No channels'
  const when =
    !cadence || cadence === 'instant' || cadence === 'immediate'
      ? 'instantly'
      : cadence === 'daily'
        ? 'daily digest'
        : cadence === 'weekly'
          ? 'weekly digest'
          : cadence
  return `${channels}, ${when}`
}

function lastFired(at?: string | null): string | null {
  return at ? `last fired ${formatRelative(at)}` : null
}

// ── Building blocks ──────────────────────────────────────────────────────────

/** Two-step remove: first click asks, second confirms. No modal for a
 *  single-row unsubscribe. */
function RemoveButton({
  label,
  onRemove,
  busy
}: {
  label: string
  onRemove: () => void
  busy: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  if (confirming) {
    return (
      <span className='flex shrink-0 items-center gap-1 text-[11px]'>
        <button
          type='button'
          disabled={busy}
          onClick={onRemove}
          className='rounded bg-red-500/10 px-1.5 py-0.5 font-medium text-red-600 hover:bg-red-500/20 disabled:opacity-50 dark:text-red-400'
        >
          Remove
        </button>
        <button
          type='button'
          onClick={() => setConfirming(false)}
          className='rounded px-1 py-0.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-muted'
        >
          Keep
        </button>
      </span>
    )
  }
  return (
    <button
      type='button'
      onClick={() => setConfirming(true)}
      aria-label={`Remove ${label}`}
      title='Remove'
      className='shrink-0 rounded p-1 text-slate-500 opacity-0 transition-opacity duration-150 hover:bg-red-500/10 hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100 dark:text-slate-400'
    >
      <X className='h-3.5 w-3.5' />
    </button>
  )
}

/** Clickable channel toggle — a real control, not a decoration chip. */
function ChannelToggle({
  label,
  on,
  onToggle,
  disabled
}: {
  label: string
  on: boolean
  onToggle?: () => void
  disabled?: boolean
}) {
  const Tag = onToggle ? 'button' : 'span'
  return (
    <Tag
      {...(onToggle ? { type: 'button' as const, onClick: onToggle, disabled } : {})}
      title={onToggle ? `Turn ${label} ${on ? 'off' : 'on'}` : undefined}
      className={[
        'rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors duration-150',
        on
          ? 'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
          : 'bg-slate-100 text-slate-500 line-through dark:bg-muted dark:text-slate-400',
        onToggle ? 'cursor-pointer hover:ring-1 hover:ring-nvr-cyan/40' : ''
      ].join(' ')}
    >
      {label}
    </Tag>
  )
}

function Row({
  title,
  description,
  meta,
  controls,
  onRemove,
  removing
}: {
  title: string
  description?: string | null
  meta?: string | null
  controls?: React.ReactNode
  onRemove?: () => void
  removing?: boolean
}) {
  return (
    <div className='group flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-slate-50 dark:hover:bg-muted/40'>
      <div className='min-w-0 flex-1'>
        <p className='truncate text-[12.5px] text-slate-800 dark:text-slate-100'>{title}</p>
        <p className='truncate text-[11px] text-slate-500 dark:text-slate-400'>
          {description}
          {meta && <span className='text-slate-400 dark:text-slate-500'> · {meta}</span>}
        </p>
      </div>
      {controls}
      {onRemove && <RemoveButton label={title} onRemove={onRemove} busy={!!removing} />}
    </div>
  )
}

function Section({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className='mb-1.5 flex items-baseline gap-2 border-b border-slate-100 pb-1 dark:border-border/60'>
        <h3 className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>{title}</h3>
        {hint && <span className='text-[10.5px] text-slate-400'>{hint}</span>}
      </div>
      <div className='space-y-0.5'>{children}</div>
    </section>
  )
}

const HISTORY_ICONS: Record<string, { icon: typeof Inbox; tint: string }> = {
  notification: { icon: Inbox, tint: 'text-nvr-cyan bg-nvr-cyan/10' },
  metric_alert: { icon: Gauge, tint: 'text-amber-600 bg-amber-500/10 dark:text-amber-400' },
  record_alert: { icon: BellRing, tint: 'text-red-600 bg-red-500/10 dark:text-red-400' },
  report_alert: {
    icon: FileBarChart,
    tint: 'text-purple-600 bg-purple-500/10 dark:text-purple-400'
  },
  digest_email: { icon: Inbox, tint: 'text-emerald-600 bg-emerald-500/10 dark:text-emerald-400' }
}

// ── The card ─────────────────────────────────────────────────────────────────

export function NotificationSourcesCard() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [tab, setTab] = useState<'sources' | 'history'>('sources')
  // History filters — multi-select toggles; empty selection = everything.
  const [kindFilter, setKindFilter] = useState<Set<string>>(new Set())
  const [channelFilter, setChannelFilter] = useState<Set<string>>(new Set())
  // Optional date window (yyyy-mm-dd) + progressive pagination.
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [visibleCount, setVisibleCount] = useState(25)

  const { data, isLoading } = useQuery<Sources>({
    queryKey: ['me-notification-sources'],
    queryFn: () =>
      client.request<{ data: Sources }>(get('/users/me/notification-sources')).then((r) => r.data),
    staleTime: 30_000
  })
  // Hygiene: per-source unread piles + read rate over 30 days — a source
  // nobody reads is a candidate to mute.
  const { data: hygiene = [] } = useQuery<
    Array<{ collection: string | null; total: number; unread: number; read_rate: number }>
  >({
    queryKey: ['me-notification-stats'],
    queryFn: () =>
      client
        .request<{ data: Array<{ collection: string | null; total: number; unread: number; read_rate: number }> }>(
          get('/users/me/notification-stats')
        )
        .then((r) => r.data ?? [])
        .catch(() => []),
    staleTime: 60_000
  })

  const historyQuery = useQuery<HistoryEntry[]>({
    queryKey: ['me-notification-history'],
    queryFn: () =>
      client
        .request<{ data: HistoryEntry[] }>(get('/users/me/notification-history', { limit: 200 }))
        .then((r) => r.data),
    enabled: tab === 'history',
    staleTime: 60_000
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['me-notification-sources'] })
  const remove = useMutation({
    mutationFn: (path: string) => client.request(del(path)),
    onSuccess: invalidate
  })
  const patchPath = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) =>
      client.request(patch(path, body)),
    onSuccess: invalidate
  })
  const reportSub = useMutation({
    mutationFn: ({ reportId, body }: { reportId: string; body: Record<string, unknown> | null }) =>
      client.request(put(`/report-studio/${reportId}/subscription`, body)),
    onSuccess: invalidate
  })

  if (isLoading || !data) return null
  const s = data
  const busy = remove.isPending || patchPath.isPending || reportSub.isPending

  // Workflow-state subscriptions collapse into one chip group; everything
  // else renders as rows.
  const stateSubs = s.subscriptions.filter(
    (r) => r.event_type === 'workflow_transition' && r.filter_field === 'to_state'
  )
  const otherSubs = s.subscriptions.filter((r) => !stateSubs.includes(r))

  const total =
    s.subscriptions.length +
    s.field_watches.length +
    s.record_alerts.length +
    s.metric_alerts.length +
    s.anomaly_rules.length +
    s.report_subscriptions.length +
    s.report_alerts.length +
    s.view_subscriptions.length

  const history = historyQuery.data ?? []
  const kindCounts = new Map<string, number>()
  const channelCounts = new Map<string, number>()
  for (const e of history) {
    kindCounts.set(e.kind, (kindCounts.get(e.kind) ?? 0) + 1)
    for (const c of e.channels ?? []) channelCounts.set(c, (channelCounts.get(c) ?? 0) + 1)
  }
  const filteredHistory = history.filter((e) => {
    if (kindFilter.size > 0 && !kindFilter.has(e.kind)) return false
    if (channelFilter.size > 0 && !(e.channels ?? []).some((c) => channelFilter.has(c)))
      return false
    // Date compare on the local yyyy-mm-dd — string compare is timezone-proof
    // for a window the user picked in local terms.
    const day = new Date(e.at).toLocaleDateString('sv-SE')
    if (fromDate && day < fromDate) return false
    if (toDate && day > toDate) return false
    return true
  })
  const pagedHistory = filteredHistory.slice(0, visibleCount)
  const byDay = new Map<string, HistoryEntry[]>()
  for (const e of pagedHistory) {
    const day = new Date(e.at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
    const list = byDay.get(day)
    if (list) list.push(e)
    else byDay.set(day, [e])
  }

  const digestOptions = [
    { value: 'instant', label: 'Instantly' },
    { value: 'daily', label: 'Daily digest' },
    { value: 'weekly', label: 'Weekly digest' }
  ]

  return (
    <div
      className='rounded-xl border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-notification-sources
    >
      {/* Header + tab switch */}
      <div className='flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-100 px-5 py-3.5 dark:border-border/60'>
        <BellRing className='h-4 w-4 shrink-0 text-nvr-cyan' />
        <div className='min-w-0 flex-1'>
          <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
            Notifications & alerts
          </h2>
          <p className='text-[11px] text-slate-500 dark:text-slate-400'>
            {total} sources · email delivered{' '}
            {s.preferences.email_digest === 'daily' ? 'as a daily digest' : 'instantly'}
          </p>
        </div>
        <div className='flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-muted'>
          {(
            [
              { key: 'sources', label: 'Sources' },
              { key: 'history', label: 'History' }
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type='button'
              onClick={() => setTab(t.key)}
              aria-pressed={tab === t.key}
              className={[
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors duration-150',
                tab === t.key
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-foreground'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'sources' && (
        <>
          {hygiene.some((h) => h.unread >= 25) && (
            <div className='mb-3 space-y-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-400/10'>
              <p className='text-[11.5px] font-medium text-amber-800 dark:text-amber-300'>
                Unread piles — the important ones drown under these:
              </p>
              {hygiene
                .filter((h) => h.unread >= 25)
                .slice(0, 4)
                .map((h) => (
                  <p key={h.collection ?? 'general'} className='text-[11.5px] text-amber-700 dark:text-amber-200/90'>
                    {h.unread.toLocaleString()} unread from{' '}
                    <span className='font-mono text-[11px]'>{h.collection ?? 'general'}</span>
                    {` — you read ${h.read_rate}% of these in the last 30 days`}
                  </p>
                ))}
              <p className='text-[11px] text-amber-600/90 dark:text-amber-400/80'>
                Consider muting or switching the source below to a daily digest.
              </p>
            </div>
          )}
        <div className='space-y-5 px-5 py-4'>
          {stateSubs.length > 0 && (
            <Section
              title='Workflow state changes'
              hint='email + in-app when a matching workflow enters the state'
            >
              {stateSubs.map((r) => (
                <Row
                  key={r.id}
                  title={
                    r.state_label || titleCase(String(r.filter_value ?? '').replace(/_/g, ' '))
                  }
                  description={
                    r.criteria && r.criteria.length > 0
                      ? `Only when ${r.criteria.join(' · ')}`
                      : 'Any workflow entering this state'
                  }
                  meta={r.is_active ? null : 'paused'}
                  onRemove={() => remove.mutate(`/notification-subscriptions/${r.id}`)}
                  removing={busy}
                />
              ))}
            </Section>
          )}

          {otherSubs.length > 0 && (
            <Section title='Record & collection subscriptions'>
              {otherSubs.map((r) => (
                <Row
                  key={r.id}
                  title={
                    r.label ||
                    (r.queue_name
                      ? `Queue digest — ${r.queue_name}`
                      : `${titleCase((r.collection ?? '?').replace(/_/g, ' '))} — every ${r.event_type === 'all' ? 'change' : r.event_type}`)
                  }
                  description={
                    r.criteria && r.criteria.length > 0
                      ? `Only when ${r.criteria.join(' · ')} — ${deliveryPhrase(true, true, r.digest_frequency)}`
                      : deliveryPhrase(true, true, r.digest_frequency)
                  }
                  meta={r.is_active ? null : 'paused'}
                  controls={
                    <SimpleSelectXs
                      value={r.digest_frequency ?? 'instant'}
                      options={digestOptions}
                      onChange={(v: string) =>
                        patchPath.mutate({
                          path: `/notification-subscriptions/${r.id}`,
                          body: { digest_frequency: v }
                        })
                      }
                    />
                  }
                  onRemove={() => remove.mutate(`/notification-subscriptions/${r.id}`)}
                  removing={busy}
                />
              ))}
            </Section>
          )}

          {s.field_watches.length > 0 && (
            <Section title='Field watches'>
              {s.field_watches.map((r) => (
                <Row
                  key={r.id}
                  title={r.name}
                  description={`Notifies when ${titleCase(r.collection.replace(/_/g, ' '))} · ${r.field.replace(/_/g, ' ')} changes`}
                  onRemove={() => remove.mutate(`/field-watches/${r.watch_id}/subscribe`)}
                  removing={busy}
                />
              ))}
            </Section>
          )}

          {s.record_alerts.length > 0 && (
            <Section title='Record alerts'>
              {s.record_alerts.map((r) => (
                <Row
                  key={r.id}
                  title={r.name}
                  description={deliveryPhrase(Boolean(r.notify_email), Boolean(r.notify_inapp))}
                  meta={lastFired(r.last_fired) ?? (r.is_active ? null : 'paused')}
                  onRemove={() => remove.mutate(`/alerts/subscriptions/${r.id}`)}
                  removing={busy}
                />
              ))}
            </Section>
          )}

          {s.metric_alerts.length > 0 && (
            <Section title='Metric alerts'>
              {s.metric_alerts.map((r) => (
                <Row
                  key={r.id}
                  title={`${humanMetric(r.metric_key)} ${OP_WORDS[r.operator] ?? r.operator} ${Number(r.threshold_value).toLocaleString('en-US')}`}
                  description={deliveryPhrase(
                    Boolean(r.delivery_email),
                    Boolean(r.delivery_in_app),
                    r.digest_frequency
                  )}
                  meta={
                    lastFired(r.last_notified) ??
                    (r.rule_status === 'active' ? null : r.rule_status)
                  }
                  controls={
                    <span className='flex shrink-0 items-center gap-1'>
                      <ChannelToggle
                        label='email'
                        on={Boolean(r.delivery_email)}
                        disabled={busy}
                        onToggle={() =>
                          patchPath.mutate({
                            path: `/metric-alerts/subscriptions/${r.id}`,
                            body: { delivery_email: !r.delivery_email }
                          })
                        }
                      />
                      <ChannelToggle
                        label='in-app'
                        on={Boolean(r.delivery_in_app)}
                        disabled={busy}
                        onToggle={() =>
                          patchPath.mutate({
                            path: `/metric-alerts/subscriptions/${r.id}`,
                            body: { delivery_in_app: !r.delivery_in_app }
                          })
                        }
                      />
                    </span>
                  }
                  onRemove={() => remove.mutate(`/metric-alerts/subscriptions/${r.id}`)}
                  removing={busy}
                />
              ))}
            </Section>
          )}

          {s.anomaly_rules.length > 0 && (
            <Section title='Anomaly detection' hint='rules you created — detections come to you'>
              {s.anomaly_rules.map((r) => (
                <Row
                  key={r.id}
                  title={r.name}
                  description={`${deliveryPhrase(Boolean(r.delivery_email), Boolean(r.delivery_in_app))} · checked ${r.check_frequency}`}
                  meta={r.status === 'active' ? null : r.status}
                  controls={
                    <span className='flex shrink-0 items-center gap-1'>
                      <ChannelToggle
                        label='email'
                        on={Boolean(r.delivery_email)}
                        disabled={busy}
                        onToggle={() =>
                          patchPath.mutate({
                            path: `/metric-alerts/anomaly-rules/${r.id}`,
                            body: { delivery_email: !r.delivery_email }
                          })
                        }
                      />
                      <ChannelToggle
                        label='in-app'
                        on={Boolean(r.delivery_in_app)}
                        disabled={busy}
                        onToggle={() =>
                          patchPath.mutate({
                            path: `/metric-alerts/anomaly-rules/${r.id}`,
                            body: { delivery_in_app: !r.delivery_in_app }
                          })
                        }
                      />
                    </span>
                  }
                />
              ))}
            </Section>
          )}

          {s.report_subscriptions.length > 0 && (
            <Section title='Report digests'>
              {s.report_subscriptions.map((r) => (
                <Row
                  key={r.id}
                  title={r.name}
                  description={[
                    deliveryPhrase(Boolean(r.delivery_email), Boolean(r.delivery_inapp), r.cadence),
                    Boolean(r.deliver_teams) && 'Teams',
                    Boolean(r.attach_pdf) && 'PDF attached'
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  meta={r.last_sent_at ? `last sent ${formatRelative(r.last_sent_at)}` : null}
                  controls={
                    <SimpleSelectXs
                      value={r.cadence}
                      options={[
                        { value: 'daily', label: 'Daily' },
                        { value: 'weekly', label: 'Weekly' }
                      ]}
                      onChange={(v: string) =>
                        reportSub.mutate({ reportId: r.report_id, body: { cadence: v } })
                      }
                    />
                  }
                  onRemove={() => reportSub.mutate({ reportId: r.report_id, body: null })}
                  removing={busy}
                />
              ))}
            </Section>
          )}

          {s.report_alerts.length > 0 && (
            <Section title='Report alerts' hint='you created these'>
              {s.report_alerts.map((r) => (
                <Row
                  key={r.id}
                  title={r.name}
                  description={`${r.report_name} · ${deliveryPhrase(Boolean(r.delivery_email), Boolean(r.delivery_inapp))}`}
                  onRemove={() => remove.mutate(`/report-studio/${r.report_id}/alerts/${r.id}`)}
                  removing={busy}
                />
              ))}
            </Section>
          )}

          {s.view_subscriptions.length > 0 && (
            <Section
              title='Saved-view digests'
              hint='which records entered the view since last time'
            >
              {s.view_subscriptions.map((r) => (
                <Row
                  key={r.id}
                  title={r.name}
                  description={`${titleCase(r.collection.replace(/_/g, ' '))} · ${r.digest} email`}
                  meta={r.last_run_at ? `last sent ${formatRelative(r.last_run_at)}` : null}
                  onRemove={() => remove.mutate(`/view-subscriptions/${r.id}`)}
                  removing={busy}
                />
              ))}
            </Section>
          )}

          {(s.chat_rooms.length > 0 || s.push_devices.length > 0) && (
            <Section title='Chat & devices'>
              {s.chat_rooms.map((r) => (
                <Row
                  key={r.room}
                  title={r.room.replace(/^ch:/, '#')}
                  description={
                    r.is_muted ? 'Muted — no notifications from this room' : 'Mentions only'
                  }
                />
              ))}
              {s.push_devices.length > 0 && (
                <Row
                  title={`Browser push — ${s.push_devices.length} device${s.push_devices.length === 1 ? '' : 's'}`}
                  description='Push notifications mirror your in-app notifications'
                />
              )}
            </Section>
          )}

          {(s.implicit.owner_group_memberships.length > 0 ||
            s.implicit.sla_escalations.length > 0) && (
            <Section
              title='Because of your role'
              hint='these follow from assignments, not subscriptions — an admin manages them'
            >
              {s.implicit.owner_group_memberships.map((m) => (
                <Row
                  key={m.template}
                  title={`Pipeline owner — ${m.template}`}
                  description={`Owner notifications + daily-digest items for records you own (${m.groups} owner group${m.groups === 1 ? '' : 's'})`}
                />
              ))}
              {s.implicit.sla_escalations.map((r) => (
                <Row
                  key={r.id}
                  title={`SLA escalation — ${r.name}`}
                  description={`Emailed when ${r.template ? `${r.template} · ` : ''}${titleCase(r.state_key.replace(/_/g, ' '))} breaches its deadline`}
                />
              ))}
            </Section>
          )}

          {total === 0 && (
            <div className='px-2 py-6 text-center'>
              <p className='text-[13px] font-medium text-slate-700 dark:text-slate-200'>
                No subscriptions or alerts
              </p>
              <p className='mt-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
                You only receive what your role implies: mentions, tasks assigned to you, and
                records you own. Subscribe from any record's bell, queue, report, or saved view.
              </p>
            </div>
          )}
        </div>
        </>
      )}

      {tab === 'history' && (
        <div className='px-5 py-4'>
          {history.length > 0 && (
            <div className='mb-3 flex flex-wrap items-center gap-x-4 gap-y-2'>
              <FilterPills
                label='Type'
                options={[
                  { key: 'notification', label: 'Notifications' },
                  { key: 'metric_alert', label: 'Metric alerts' },
                  { key: 'record_alert', label: 'Record alerts' },
                  { key: 'report_alert', label: 'Report alerts' },
                  { key: 'digest_email', label: 'Digest emails' }
                ].filter((o) => (kindCounts.get(o.key) ?? 0) > 0)}
                counts={kindCounts}
                selected={kindFilter}
                onChange={(next) => {
                  setKindFilter(next)
                  setVisibleCount(25)
                }}
              />
              <FilterPills
                label='Delivered via'
                options={[...channelCounts.keys()].sort().map((c) => ({ key: c, label: c }))}
                counts={channelCounts}
                selected={channelFilter}
                onChange={(next) => {
                  setChannelFilter(next)
                  setVisibleCount(25)
                }}
              />
              <span className='flex items-center gap-1.5'>
                <span className='text-[10.5px] font-semibold text-slate-500 dark:text-slate-400'>
                  Between
                </span>
                <input
                  type='date'
                  value={fromDate}
                  onChange={(e) => {
                    setFromDate(e.target.value)
                    setVisibleCount(25)
                  }}
                  aria-label='From date'
                  className='h-6 rounded border border-slate-200 bg-white px-1.5 text-[11px] text-slate-700 dark:border-border dark:bg-card dark:text-slate-200'
                />
                <span className='text-[10.5px] text-slate-400'>and</span>
                <input
                  type='date'
                  value={toDate}
                  onChange={(e) => {
                    setToDate(e.target.value)
                    setVisibleCount(25)
                  }}
                  aria-label='To date'
                  className='h-6 rounded border border-slate-200 bg-white px-1.5 text-[11px] text-slate-700 dark:border-border dark:bg-card dark:text-slate-200'
                />
              </span>
              {(kindFilter.size > 0 || channelFilter.size > 0 || fromDate || toDate) && (
                <button
                  type='button'
                  onClick={() => {
                    setKindFilter(new Set())
                    setChannelFilter(new Set())
                    setFromDate('')
                    setToDate('')
                    setVisibleCount(25)
                  }}
                  className='text-[11px] text-slate-500 underline decoration-dotted underline-offset-2 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                >
                  Clear ({filteredHistory.length} of {history.length})
                </button>
              )}
            </div>
          )}
          {historyQuery.isLoading ? (
            <div className='space-y-2 py-2'>
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className='h-9 animate-pulse rounded-md bg-slate-100 dark:bg-muted' />
              ))}
            </div>
          ) : history.length === 0 ? (
            <div className='px-2 py-6 text-center'>
              <History className='mx-auto mb-2 h-5 w-5 text-slate-300 dark:text-slate-600' />
              <p className='text-[13px] font-medium text-slate-700 dark:text-slate-200'>
                Nothing delivered yet
              </p>
              <p className='mt-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
                When a subscription or alert fires, it shows up here with the time it was sent.
              </p>
            </div>
          ) : filteredHistory.length === 0 ? (
            <p className='px-2 py-6 text-center text-[12px] text-slate-500 dark:text-slate-400'>
              Nothing matches these filters — clear them to see all {history.length} entries.
            </p>
          ) : (
            <div className='space-y-4'>
              {[...byDay.entries()].map(([day, entries]) => (
                <div key={day}>
                  <p className='mb-1 text-[10.5px] font-semibold text-slate-400'>{day}</p>
                  <div className='space-y-0.5'>
                    {entries.map((e, i) => {
                      const cfg = HISTORY_ICONS[e.kind] ?? {
                        icon: Activity,
                        tint: 'text-slate-500 bg-slate-100 dark:bg-muted'
                      }
                      const Icon = cfg.icon
                      return (
                        <div
                          key={`${e.kind}-${e.at}-${i}`}
                          className='flex items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-slate-50 dark:hover:bg-muted/40'
                        >
                          <span
                            className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${cfg.tint}`}
                          >
                            <Icon className='h-3 w-3' />
                          </span>
                          <div className='min-w-0 flex-1'>
                            <p className='text-[12.5px] text-slate-800 dark:text-slate-100'>
                              {e.title}
                            </p>
                            {e.detail && (
                              <p className='truncate text-[11px] text-slate-500 dark:text-slate-400'>
                                {e.detail}
                              </p>
                            )}
                          </div>
                          <span className='flex shrink-0 items-center gap-1.5'>
                            {/* How it reached you — accurate per source; the
                                email leg of instant sends has no per-row log
                                and is never guessed. */}
                            {(e.channels ?? []).map((c) => (
                              <span
                                key={c}
                                className='rounded bg-slate-100 px-1 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-slate-600 dark:bg-muted dark:text-slate-300'
                              >
                                {c}
                              </span>
                            ))}
                            <span
                              className='text-[10.5px] tabular-nums text-slate-400'
                              title={new Date(e.at).toLocaleString()}
                            >
                              {new Date(e.at).toLocaleTimeString('en-US', {
                                hour: 'numeric',
                                minute: '2-digit'
                              })}
                            </span>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
              {filteredHistory.length > visibleCount && (
                <div className='pt-1 text-center'>
                  <button
                    type='button'
                    onClick={() => setVisibleCount((n) => n + 25)}
                    className='rounded-md border border-slate-200 px-3 py-1 text-[11.5px] font-medium text-slate-600 transition-colors duration-150 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
                  >
                    Show 25 more ({filteredHistory.length - visibleCount} remaining)
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Multi-select pill group: click toggles; empty selection means "all".
 *  Counts keep the choice honest — you can see what a filter will keep. */
function FilterPills({
  label,
  options,
  counts,
  selected,
  onChange
}: {
  label: string
  options: Array<{ key: string; label: string }>
  counts: Map<string, number>
  selected: Set<string>
  onChange: (next: Set<string>) => void
}) {
  if (options.length === 0) return null
  return (
    <span className='flex flex-wrap items-center gap-1.5'>
      <span className='text-[10.5px] font-semibold text-slate-500 dark:text-slate-400'>
        {label}
      </span>
      {options.map((o) => {
        const on = selected.has(o.key)
        return (
          <button
            key={o.key}
            type='button'
            aria-pressed={on}
            onClick={() => {
              const next = new Set(selected)
              if (on) next.delete(o.key)
              else next.add(o.key)
              onChange(next)
            }}
            className={[
              'rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-150',
              on
                ? 'border-nvr-cyan bg-nvr-cyan/10 font-medium text-nvr-navy dark:text-nvr-cyan'
                : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-border dark:text-slate-300'
            ].join(' ')}
          >
            {o.label}
            <span className={on ? 'ml-1 opacity-70' : 'ml-1 text-slate-400 dark:text-slate-500'}>
              {counts.get(o.key) ?? 0}
            </span>
          </button>
        )
      })}
    </span>
  )
}
