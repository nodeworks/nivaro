import { ChevronDown, Loader2 } from 'lucide-react'
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react'
import { useDebounced } from '../../../hooks/useDebounced'
import { cn, titleCase } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Switch } from '../../ui/switch'
import {
  useAlertSubscriptions,
  useSaveSignalSettings,
  useSignalPreview,
  useSignalSettings,
  useToggleSubscription
} from './api'
import { Segment } from './EventsView'
import { agoText, exactTime, TONE_SOFT, TONE_TEXT, type Tone } from './tone'
import type { AlertMode, AlertSubscription, SignalSettingsEntry, SignalThreshold } from './types'

const CRITICAL = '*critical'
/** Signals whose tab is not a console tab of its own. */
const PUSHES_TAB = 'pushes'
const FALLBACK_TAB_LABELS: Record<string, string> = { [PUSHES_TAB]: 'Outbound pushes' }
/** The stale-import signal also carries per-import cadences, edited elsewhere. */
const STALE_IMPORT_SIGNAL = 'core:import-stale'

function errorText(err: unknown): string {
  const e = err as { response?: { error?: string }; message?: string }
  return e?.response?.error ?? e?.message ?? 'Something went wrong'
}

function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-px text-[11px] font-medium',
        TONE_SOFT[tone],
        tone === 'neutral' ? 'text-muted-foreground' : TONE_TEXT[tone]
      )}
    >
      {children}
    </span>
  )
}

function SeverityChip({ entry }: { entry: SignalSettingsEntry }) {
  if (!entry.settings.enabled) return <Chip tone='neutral'>Off</Chip>
  return entry.settings.severity === 'critical' ? (
    <Chip tone='negative'>Critical</Chip>
  ) : (
    <Chip tone='warning'>Warning</Chip>
  )
}

/** Signals grouped by the console tab they live on, in console tab order. */
function groupByTab(
  list: SignalSettingsEntry[],
  tabLabels: Record<string, string>
): Array<{ tab: string; label: string; items: SignalSettingsEntry[] }> {
  const labels = { ...FALLBACK_TAB_LABELS, ...tabLabels }
  // Outbound pushes sit with the partners they go to, not after every tab.
  const order = Object.keys(tabLabels).flatMap((k) =>
    k === 'partners' && !(PUSHES_TAB in tabLabels) ? [k, PUSHES_TAB] : [k]
  )
  const groups = new Map<string, SignalSettingsEntry[]>()
  for (const s of list) {
    const g = groups.get(s.tab) ?? []
    g.push(s)
    groups.set(s.tab, g)
  }
  const rank = (t: string) => {
    const i = order.indexOf(t)
    return i === -1 ? order.length : i
  }
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([tab, items]) => ({
      tab,
      label: labels[tab] ?? titleCase(tab),
      items: [...items].sort((a, b) => a.label.localeCompare(b.label))
    }))
}

function SectionHead({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className='min-w-0'>
      <h2 className='text-[14px] font-semibold text-foreground'>{title}</h2>
      <p className='mt-0.5 max-w-[75ch] text-[12.5px] text-muted-foreground'>{children}</p>
    </div>
  )
}

function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className='space-y-px overflow-hidden rounded-lg border border-border' aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className='h-[56px] animate-pulse bg-[hsl(var(--nvr-skeleton))]' />
      ))}
    </div>
  )
}

// ── My alerts ───────────────────────────────────────────────────────────────

function SubscriptionSwitch({
  signal,
  mode,
  label,
  subs
}: {
  signal: string
  mode: AlertMode
  label: string
  subs: AlertSubscription[]
}) {
  const toggle = useToggleSubscription()
  const current = subs.find((s) => s.signal === signal && s.mode === mode)
  // Show the intended state while the write is in flight, never a flicker back.
  const pendingOn = toggle.isPending ? toggle.variables?.on : undefined
  const checked = pendingOn ?? !!current
  return (
    <div className='flex flex-col items-center gap-1'>
      <Switch
        checked={checked}
        disabled={toggle.isPending}
        aria-label={`${mode === 'realtime' ? 'Real-time alerts' : 'Daily summary'} for ${label}`}
        data-ic-sub={`${signal}:${mode}`}
        onCheckedChange={(on) => toggle.mutate({ signal, mode, on, id: current?.id })}
      />
      {toggle.isError && (
        <span role='alert' className={cn('text-[11px]', TONE_TEXT.negative)}>
          {errorText(toggle.error)}
        </span>
      )}
    </div>
  )
}

function MyAlertsSection({
  groups,
  entries
}: {
  groups: ReturnType<typeof groupByTab>
  entries: SignalSettingsEntry[]
}) {
  const subs = useAlertSubscriptions()
  const list = subs.data ?? []
  // `*critical` is a standing pseudo-signal, never stale. Anything else has
  // to still be a registered problem — one this instance no longer checks
  // (a code change, an extension removed) leaves a subscription row behind
  // with nothing to turn back on.
  const knownIds = useMemo(() => new Set(entries.map((e) => e.id)), [entries])
  const known = list.filter((s) => s.signal === CRITICAL || knownIds.has(s.signal))
  const stale = list.filter((s) => s.signal !== CRITICAL && !knownIds.has(s.signal))
  const criticalRealtime = list.some((s) => s.signal === CRITICAL && s.mode === 'realtime')
  const criticalDigest = list.some((s) => s.signal === CRITICAL && s.mode === 'digest')
  const criticalCount = entries.filter(
    (e) => e.settings.enabled && e.settings.severity === 'critical'
  ).length
  const active = known.length
  const lastSent = list
    .map((s) => s.last_notified_at)
    .filter((x): x is string => !!x)
    .sort()
    .at(-1)

  return (
    <section className='space-y-3' data-ic-my-alerts>
      <SectionHead title='My alerts'>
        Nothing is sent unless you turn it on here. Delivery follows your notification rules for
        Integrations. A problem already on the board while snoozed or during maintenance won't alert
        when it resurfaces unless it happens again.
      </SectionHead>

      {subs.isLoading ? (
        <ListSkeleton />
      ) : subs.isError ? (
        <p className={cn('text-[12.5px]', TONE_TEXT.negative)}>Couldn't load your alerts.</p>
      ) : (
        <div className='overflow-x-auto rounded-lg border border-border bg-card'>
          <table className='w-full min-w-[640px] border-collapse text-left'>
            <caption className='caption-top px-4 pb-2 pt-3 text-left text-[12px] text-muted-foreground'>
              {active === 0
                ? 'You get no integration alerts yet.'
                : `${active} alert${active === 1 ? '' : 's'} on`}
              {lastSent && (
                <>
                  {' · last sent '}
                  <span data-tip={exactTime(lastSent)}>{agoText(lastSent)}</span>
                </>
              )}
            </caption>
            <thead>
              <tr className='text-[11.5px] text-muted-foreground'>
                <th scope='col' className='w-[640px] py-2 pl-4 pr-3 font-medium'>
                  Problem
                </th>
                <th scope='col' className='w-[120px] px-3 py-2 text-center font-medium'>
                  Real-time
                </th>
                <th scope='col' className='w-[132px] py-2 pl-3 pr-4 text-center font-medium'>
                  Daily summary
                </th>
                {/* Spacer: keeps the switches beside the problem on wide screens. */}
                <td aria-hidden className='w-auto' />
              </tr>
            </thead>
            <tbody>
              <tr className='border-t border-border align-middle' data-ic-sub-row={CRITICAL}>
                <td className='py-3 pl-4 pr-3'>
                  <p className='text-[13px] font-medium text-foreground'>All critical problems</p>
                  <p className='mt-0.5 max-w-[70ch] text-[12px] text-muted-foreground'>
                    Every problem marked Critical — {criticalCount} right now — including any raised
                    to Critical later.
                  </p>
                </td>
                <td className='px-3 py-3'>
                  <SubscriptionSwitch
                    signal={CRITICAL}
                    mode='realtime'
                    label='all critical problems'
                    subs={list}
                  />
                </td>
                <td className='py-3 pl-3 pr-4'>
                  <SubscriptionSwitch
                    signal={CRITICAL}
                    mode='digest'
                    label='all critical problems'
                    subs={list}
                  />
                </td>
                <td aria-hidden />
              </tr>
              {groups.map((g) => (
                <GroupRows
                  key={g.tab}
                  label={g.label}
                  items={g.items}
                  subs={list}
                  criticalRealtime={criticalRealtime}
                  criticalDigest={criticalDigest}
                />
              ))}
              {stale.length > 0 && (
                <>
                  <tr className='border-t border-border bg-muted/40'>
                    <th
                      scope='colgroup'
                      colSpan={4}
                      className='py-1.5 pl-4 pr-3 text-[11.5px] font-medium text-foreground'
                    >
                      No longer available
                    </th>
                  </tr>
                  {stale.map((s) => (
                    <StaleSubscriptionRow key={s.id} sub={s} />
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function StaleSubscriptionRow({ sub }: { sub: AlertSubscription }) {
  const toggle = useToggleSubscription()
  return (
    <tr className='border-t border-border align-middle' data-ic-stale-sub={sub.id}>
      {/* One cell, flexed — a split colSpan={3}+td pair would leave the
          button stranded in the spacer column's leftover width on a wide
          screen, far from the text it belongs to. */}
      <td className='py-3 pl-4 pr-4' colSpan={4}>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <div className='min-w-0'>
            <p className='text-[13px] font-medium text-foreground'>{sub.signal}</p>
            <p className='mt-0.5 text-[12px] text-muted-foreground'>
              {sub.mode === 'realtime' ? 'Real-time' : 'Daily summary'} — this problem is no longer
              registered on this instance.
            </p>
          </div>
          <Button
            size='sm'
            variant='outline'
            className='h-8 shrink-0'
            disabled={toggle.isPending}
            onClick={() =>
              toggle.mutate({ signal: sub.signal, mode: sub.mode, on: false, id: sub.id })
            }
            data-ic-stale-remove={sub.id}
          >
            {toggle.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden />}
            Remove
          </Button>
        </div>
      </td>
    </tr>
  )
}

function GroupRows({
  label,
  items,
  subs,
  criticalRealtime,
  criticalDigest
}: {
  label: string
  items: SignalSettingsEntry[]
  subs: AlertSubscription[]
  criticalRealtime: boolean
  criticalDigest: boolean
}) {
  return (
    <>
      <tr className='border-t border-border bg-muted/40'>
        <th
          scope='colgroup'
          colSpan={4}
          className='py-1.5 pl-4 pr-3 text-[11.5px] font-medium text-foreground'
        >
          {label}
        </th>
      </tr>
      {items.map((e) => {
        const critical = e.settings.enabled && e.settings.severity === 'critical'
        const covered = critical && (criticalRealtime || criticalDigest)
        return (
          <tr key={e.id} className='border-t border-border align-middle' data-ic-sub-row={e.id}>
            <td className='py-3 pl-4 pr-3'>
              <div className='flex flex-wrap items-center gap-2'>
                <p className='text-[13px] font-medium text-foreground'>{e.label}</p>
                <SeverityChip entry={e} />
              </div>
              <p className='mt-0.5 max-w-[70ch] text-[12px] text-muted-foreground'>
                {e.description}
              </p>
              {covered && (
                <p className='mt-0.5 text-[11.5px] text-muted-foreground'>
                  Also covered by All critical problems (
                  {[criticalRealtime && 'real-time', criticalDigest && 'daily summary']
                    .filter(Boolean)
                    .join(', ')}
                  ).
                </p>
              )}
              {!e.settings.enabled && (
                <p className='mt-0.5 text-[11.5px] text-muted-foreground'>
                  Not being checked — turn it on under Thresholds below.
                </p>
              )}
            </td>
            <td className='px-3 py-3'>
              <SubscriptionSwitch signal={e.id} mode='realtime' label={e.label} subs={subs} />
            </td>
            <td className='py-3 pl-3 pr-4'>
              <SubscriptionSwitch signal={e.id} mode='digest' label={e.label} subs={subs} />
            </td>
            <td aria-hidden />
          </tr>
        )
      })}
    </>
  )
}

// ── Thresholds ──────────────────────────────────────────────────────────────

interface Draft {
  enabled: boolean
  severity: 'critical' | 'warn'
  values: Record<string, string>
}

function draftFrom(e: SignalSettingsEntry): Draft {
  const values: Record<string, string> = {}
  for (const t of e.thresholds) values[t.key] = String(e.settings.thresholds[t.key] ?? t.default)
  return { enabled: e.settings.enabled, severity: e.settings.severity, values }
}

function thresholdProblem(t: SignalThreshold, raw: string): string | null {
  if (!raw.trim()) return 'Enter a number.'
  const n = Number(raw)
  if (!Number.isFinite(n)) return 'Enter a number.'
  if (t.min != null && n < t.min) return `At least ${t.min.toLocaleString()}.`
  if (t.max != null && n > t.max) return `At most ${t.max.toLocaleString()}.`
  return null
}

const unitText = (t: SignalThreshold) => (t.unit === '%' ? '%' : t.unit)

function thresholdSummary(e: SignalSettingsEntry): string {
  return e.thresholds
    .map((t) => {
      const v = e.settings.thresholds[t.key] ?? t.default
      return `${t.label} ${v.toLocaleString()}${t.unit === '%' ? '%' : ` ${t.unit}`}`
    })
    .join(' · ')
}

function ThresholdRow({
  entry,
  open,
  onToggle,
  onJumpTab
}: {
  entry: SignalSettingsEntry
  open: boolean
  onToggle: () => void
  onJumpTab?: (key: string) => void
}) {
  const bodyId = useId()
  return (
    <li className='border-t border-border first:border-t-0' data-ic-threshold={entry.id}>
      <button
        type='button'
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className='flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 dark:hover:bg-muted/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
      >
        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='text-[13px] font-medium text-foreground'>{entry.label}</span>
            <SeverityChip entry={entry} />
          </div>
          <p className='mt-0.5 text-[12px] text-muted-foreground'>
            {entry.thresholds.length > 0 ? thresholdSummary(entry) : entry.description}
          </p>
        </div>
        <span className='mt-0.5 inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-muted-foreground'>
          {open ? 'Close' : 'Edit'}
          <ChevronDown
            className={cn('h-4 w-4 transition-transform duration-150', open && 'rotate-180')}
            aria-hidden
          />
        </span>
      </button>
      {open && (
        <div id={bodyId}>
          <ThresholdEditor entry={entry} onDone={onToggle} onJumpTab={onJumpTab} />
        </div>
      )}
    </li>
  )
}

function ThresholdEditor({
  entry,
  onDone,
  onJumpTab
}: {
  entry: SignalSettingsEntry
  onDone: () => void
  onJumpTab?: (key: string) => void
}) {
  const save = useSaveSignalSettings()
  const [draft, setDraft] = useState<Draft>(() => draftFrom(entry))
  const [saved, setSaved] = useState(false)
  const baseId = useId()
  // A save refetches the entry — adopt it so "unchanged" means unchanged again.
  useEffect(() => setDraft(draftFrom(entry)), [entry])

  const problems = Object.fromEntries(
    entry.thresholds.map((t) => [t.key, thresholdProblem(t, draft.values[t.key] ?? '')])
  )
  const valid = Object.values(problems).every((p) => p == null)
  const base = draftFrom(entry)
  const changedKeys = entry.thresholds
    .map((t) => t.key)
    .filter((k) => Number(draft.values[k]) !== Number(base.values[k]))
  const dirty =
    changedKeys.length > 0 || draft.enabled !== base.enabled || draft.severity !== base.severity

  // Preview asks about the thresholds only (severity/on-off don't change the count).
  const previewValues = useMemo(
    () =>
      valid
        ? Object.fromEntries(entry.thresholds.map((t) => [t.key, Number(draft.values[t.key])]))
        : null,
    [valid, entry.thresholds, draft.values]
  )
  const debounced = useDebounced(previewValues, 500)
  const preview = useSignalPreview(entry.id, debounced)
  const previewStale = JSON.stringify(debounced) !== JSON.stringify(previewValues)

  const submit = () => {
    const values: Record<string, number | string | boolean | null> = {}
    for (const k of changedKeys) {
      const t = entry.thresholds.find((x) => x.key === k)
      const n = Number(draft.values[k])
      // Back at the default = drop the stored override.
      values[k] = t && n === t.default ? null : n
    }
    if (draft.enabled !== base.enabled) values.enabled = draft.enabled
    if (draft.severity !== base.severity) values.severity = draft.severity
    setSaved(false)
    save.mutate({ signal: entry.id, values }, { onSuccess: () => setSaved(true) })
  }

  const thresholdsChanged = changedKeys.length > 0
  let previewText: ReactNode
  if (!draft.enabled) previewText = 'Off — this problem will not be checked or shown.'
  else if (!valid) previewText = 'Fix the values above to see what would be flagged.'
  else if (preview.isError) previewText = `Couldn't preview: ${errorText(preview.error)}`
  else if (preview.data?.error) previewText = `Couldn't preview: ${preview.data.error}`
  else if (preview.data?.count == null || previewStale || preview.isFetching) {
    previewText = (
      <span className='inline-flex items-center gap-1.5'>
        <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden />
        Checking…
      </span>
    )
  } else {
    const n = preview.data.count
    previewText = `${thresholdsChanged ? 'Would currently flag' : 'Currently flags'} ${n.toLocaleString()}`
  }

  return (
    <div className='space-y-4 border-t border-border bg-muted/30 px-4 py-4 dark:bg-muted/15'>
      <p className='max-w-[75ch] text-[12.5px] text-muted-foreground'>{entry.description}</p>

      <div className='flex flex-wrap items-end gap-x-8 gap-y-4'>
        <div className='flex items-center gap-2.5'>
          <Switch
            id={`${baseId}-enabled`}
            checked={draft.enabled}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
            data-ic-threshold-enabled={entry.id}
          />
          <label
            htmlFor={`${baseId}-enabled`}
            className='text-[12.5px] font-medium text-foreground'
          >
            Check for this problem
          </label>
        </div>
        <div className='space-y-1'>
          <p className='text-[11.5px] text-muted-foreground' id={`${baseId}-sev`}>
            Severity
          </p>
          <Segment
            value={draft.severity}
            options={[
              ['critical', 'Critical'],
              ['warn', 'Warning']
            ]}
            onChange={(v) => setDraft((d) => ({ ...d, severity: v }))}
            label={`Severity for ${entry.label}`}
            disabled={!draft.enabled}
            data-ic-severity={entry.id}
          />
        </div>
      </div>

      {entry.thresholds.length > 0 && (
        <div className='flex flex-wrap gap-x-8 gap-y-4'>
          {entry.thresholds.map((t) => {
            const id = `${baseId}-${t.key}`
            const problem = problems[t.key]
            const n = Number(draft.values[t.key])
            return (
              <div key={t.key} className='w-[200px] space-y-1'>
                <label htmlFor={id} className='block text-[11.5px] text-muted-foreground'>
                  {t.label}
                </label>
                <div className='flex items-center gap-2'>
                  <Input
                    id={id}
                    inputMode='decimal'
                    value={draft.values[t.key] ?? ''}
                    disabled={!draft.enabled}
                    aria-invalid={problem != null}
                    aria-describedby={`${id}-hint`}
                    data-ic-threshold-input={`${entry.id}:${t.key}`}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, values: { ...d.values, [t.key]: e.target.value } }))
                    }
                    className={cn(
                      'h-8 w-24 text-right text-[12.5px] tabular-nums',
                      problem &&
                        'border-[color:var(--nvr-role-negative,#dc2626)] dark:border-[color:var(--nvr-role-negative-dark,#e08383)]'
                    )}
                  />
                  <span className='text-[12px] text-muted-foreground'>{unitText(t)}</span>
                </div>
                <p
                  id={`${id}-hint`}
                  className={cn(
                    'text-[11px]',
                    problem ? TONE_TEXT.negative : 'text-muted-foreground'
                  )}
                >
                  {problem ??
                    (Number.isFinite(n) && n !== t.default ? (
                      <>
                        Default {t.default.toLocaleString()} ·{' '}
                        <button
                          type='button'
                          className='font-medium text-foreground underline-offset-2 hover:underline'
                          onClick={() =>
                            setDraft((d) => ({
                              ...d,
                              values: { ...d.values, [t.key]: String(t.default) }
                            }))
                          }
                        >
                          Use default
                        </button>
                      </>
                    ) : (
                      `Default ${t.default.toLocaleString()}`
                    ))}
                </p>
              </div>
            )
          })}
        </div>
      )}

      {entry.id === STALE_IMPORT_SIGNAL && (
        <p className='max-w-[75ch] text-[12px] text-muted-foreground'>
          These apply to every import without its own setting. Each import's cadence — or turning
          one off — is set in the Inbound tab's import table and in the Import Console.{' '}
          {onJumpTab && (
            <button
              type='button'
              onClick={() => onJumpTab('inbound')}
              className='font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
              data-ic-jump-inbound
            >
              Open Inbound
            </button>
          )}
        </p>
      )}

      <div className='flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3'>
        <p className='text-[12.5px] text-foreground' data-ic-preview={entry.id} aria-live='polite'>
          {previewText}
        </p>
        <div className='flex items-center gap-2'>
          {save.isError && (
            <span role='alert' className={cn('text-[12px]', TONE_TEXT.negative)}>
              {errorText(save.error)}
            </span>
          )}
          {saved && !dirty && !save.isPending && (
            <span className={cn('text-[12px]', TONE_TEXT.positive)} data-ic-threshold-saved>
              Saved
            </span>
          )}
          <Button size='sm' variant='outline' className='h-8' onClick={onDone}>
            {dirty ? 'Cancel' : 'Close'}
          </Button>
          <Button
            size='sm'
            className='h-8'
            disabled={!dirty || !valid || save.isPending}
            onClick={submit}
            data-ic-threshold-save={entry.id}
          >
            {save.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden />}
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

function ThresholdsSection({
  groups,
  onJumpTab
}: {
  groups: ReturnType<typeof groupByTab>
  onJumpTab?: (key: string) => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  return (
    <section className='space-y-3' data-ic-thresholds>
      <SectionHead title='When a problem counts'>
        How long, how many or how much before each problem shows on Firefight — and whether it is
        critical. Changes apply from the next check, every five minutes. The count updates as you
        type.
      </SectionHead>
      <div className='space-y-5'>
        {groups.map((g) => (
          <div key={g.tab} className='space-y-1.5'>
            <h3 className='text-[12px] font-medium text-foreground'>{g.label}</h3>
            <ul className='overflow-hidden rounded-lg border border-border bg-card'>
              {g.items.map((e) => (
                <ThresholdRow
                  key={e.id}
                  entry={e}
                  open={openId === e.id}
                  onToggle={() => setOpenId((cur) => (cur === e.id ? null : e.id))}
                  onJumpTab={onJumpTab}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}

export interface AlertsViewProps {
  /** Console tab key → label, in console order — groups follow it. */
  tabLabels?: Record<string, string>
  onJumpTab?: (key: string) => void
}

/**
 * Alerts: who gets told (opt-in, per person) and when a problem counts
 * (per instance, admin). Both lists are grouped by the console tab each
 * problem lives on, so the page reads the way the console does.
 */
export function AlertsView({ tabLabels = {}, onJumpTab }: AlertsViewProps) {
  const settings = useSignalSettings()
  const entries = settings.data ?? []
  const groups = useMemo(() => groupByTab(entries, tabLabels), [entries, tabLabels])

  if (settings.isLoading) {
    return (
      <div className='space-y-8' data-ic-alerts>
        <ListSkeleton rows={6} />
      </div>
    )
  }
  if (settings.isError) {
    return (
      <p className={cn('text-[12.5px]', TONE_TEXT.negative)} data-ic-alerts>
        Couldn't load the list of problems: {errorText(settings.error)}
      </p>
    )
  }
  if (entries.length === 0) {
    return (
      <div className='rounded-lg border border-border bg-card px-5 py-6' data-ic-alerts>
        <p className='text-[14px] font-semibold text-foreground'>No problems to watch yet</p>
        <p className='mt-1 max-w-[70ch] text-[12.5px] text-muted-foreground'>
          Integration problems appear here once this instance registers them — failed pushes, stale
          imports, partners that stop answering. Then you can choose to be told about them.
        </p>
      </div>
    )
  }
  return (
    <div className='space-y-10' data-ic-alerts>
      <MyAlertsSection groups={groups} entries={entries} />
      <ThresholdsSection groups={groups} onJumpTab={onJumpTab} />
    </div>
  )
}
