import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Dices, Loader2, ShieldOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { cn, formatRelative } from '@/lib/utils'
import { errText } from './api'
import { FaultChecklist, inputCls, NumberBox, Row, SaveBar, Section } from './ops-controls'
import {
  type ChaosSettingsView,
  fetchChaosSettings,
  fetchMonkey,
  fetchOperator,
  type MonkeySettings,
  type MonkeyView,
  type OperatorView,
  opsKeys,
  patchChaosSettings,
  tryMonkey,
  twelveHour,
  tzLabel,
  WEEKDAYS
} from './ops-api'
import { RunChip } from './RunsTab'

/**
 * Monkey (#2829): Chaos Monkey's switch, its schedule and approved faults, what the next tick
 * would decide, and its last runs. Administrators edit; chaos operators read. The server picks
 * the moment, the fault and the small target; pre-flight and the instance's limits still apply.
 */
export function MonkeyTab() {
  const qc = useQueryClient()
  const { data: me } = useQuery<OperatorView>({
    queryKey: opsKeys.operator,
    queryFn: fetchOperator
  })
  const admin = !!me?.admin
  const { data, isLoading, isError } = useQuery<MonkeyView>({
    queryKey: opsKeys.monkey,
    queryFn: fetchMonkey,
    refetchInterval: 60_000
  })
  const { data: settings } = useQuery<ChaosSettingsView>({
    queryKey: opsKeys.settings,
    queryFn: fetchChaosSettings,
    enabled: admin
  })
  const [draft, setDraft] = useState<MonkeySettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (data) setDraft(data.monkey)
  }, [data])

  const save = useMutation({
    mutationFn: (m: MonkeySettings) => patchChaosSettings({ monkey: m }),
    onSuccess: (v) => {
      qc.setQueryData(opsKeys.settings, v)
      void qc.invalidateQueries({ queryKey: opsKeys.monkey })
      setError(null)
      toast.success('Chaos Monkey saved')
    },
    onError: (e) => setError(errText(e, 'Chaos Monkey was not saved'))
  })
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => patchChaosSettings({ monkey: { enabled } }),
    onSuccess: (_v, enabled) => {
      void qc.invalidateQueries({ queryKey: opsKeys.monkey })
      void qc.invalidateQueries({ queryKey: opsKeys.settings })
      toast.success(enabled ? 'Chaos Monkey is on' : 'Chaos Monkey is off')
    },
    onError: (e) => toast.error(errText(e, 'Chaos Monkey did not change'))
  })
  const attempt = useMutation({
    mutationFn: tryMonkey,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['chaos'] })
      if (r.acted) toast.success(r.why)
      else toast(r.why)
    },
    onError: (e) => toast.error(errText(e, 'Chaos Monkey did not run'))
  })

  if (isLoading || (!draft && !isError))
    return (
      <div className='flex-1 space-y-4 p-6'>
        <Skeleton className='h-10 w-full max-w-[640px]' />
        <Skeleton className='h-64 w-full' />
      </div>
    )
  if (isError || !data || !draft)
    return (
      <p className='p-6 text-[12.5px] text-slate-600 dark:text-muted-foreground'>
        Chaos Monkey did not load. Reload the page to try again.
      </p>
    )

  const m = data.monkey
  const dirty = JSON.stringify({ ...draft, enabled: m.enabled }) !== JSON.stringify(m)
  const set = (patch: Partial<MonkeySettings>) => setDraft({ ...draft, ...patch })
  const setHours = (patch: Partial<MonkeySettings['hours']>) =>
    setDraft({ ...draft, hours: { ...draft.hours, ...patch } })
  const candidates = settings?.candidates ?? m.faults.map((k) => ({ key: k, label: k, danger: '' }))
  const ro = !admin

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-4 py-3 sm:px-6 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <Switch
            id='monkey-on'
            checked={m.enabled}
            disabled={ro || toggle.isPending || data.production}
            onCheckedChange={(v) => toggle.mutate(v)}
            aria-describedby='monkey-why'
          />
          <label
            htmlFor='monkey-on'
            className='text-[13px] font-semibold text-slate-900 dark:text-foreground'
          >
            Chaos Monkey
          </label>
        </div>
        <p
          id='monkey-why'
          className='min-w-0 flex-1 text-[12.5px] text-slate-600 dark:text-muted-foreground'
        >
          {verdictSentence(data)}
        </p>
        <span className='text-[12px] tabular-nums text-slate-500 dark:text-muted-foreground'>
          {data.this_week} of {m.max_per_week} this week
        </span>
        {admin && (
          <button
            type='button'
            onClick={() => attempt.mutate()}
            disabled={attempt.isPending || !m.enabled}
            data-tip={
              m.enabled
                ? 'Run one tick now, skipping only the dice. Hours, limits and pre-flight still apply.'
                : 'Turn Chaos Monkey on first'
            }
            className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-50 dark:border-border dark:text-foreground dark:hover:bg-muted'
          >
            {attempt.isPending ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden />
            ) : (
              <Dices className='h-3.5 w-3.5' aria-hidden />
            )}
            Try now
          </button>
        )}
      </div>
      {data.production && (
        <div
          role='status'
          className='flex shrink-0 items-start gap-2.5 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-[12.5px] text-amber-900 sm:px-6 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200'
        >
          <ShieldOff className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
          <span>
            <span className='font-mono text-[11.5px]'>{data.instance}</span> looks like production.
            Chaos Monkey never runs here.
          </span>
        </div>
      )}

      <div className='flex flex-1 min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden'>
        <div className='px-4 pt-5 sm:px-6 lg:flex-1 lg:overflow-y-auto'>
          <div className='space-y-4 pb-6'>
            <Section
              title='When'
              help={`The monkey only acts inside these hours (${tzLabel(m.hours.tz) === 'ET' ? 'Eastern time' : m.hours.tz}), at a random moment, and no more often than the weekly count.`}
            >
              <Row label='Days'>
                <fieldset className='flex flex-wrap gap-1' aria-label='Days'>
                  {WEEKDAYS.map((d) => {
                    const on = draft.hours.days.includes(d.n)
                    return (
                      <button
                        key={d.n}
                        type='button'
                        aria-pressed={on}
                        aria-label={d.long}
                        disabled={ro}
                        onClick={() =>
                          setHours({
                            days: on
                              ? draft.hours.days.filter((x) => x !== d.n)
                              : [...draft.hours.days, d.n].sort()
                          })
                        }
                        className={cn(
                          'h-8 w-11 rounded-md border text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-default',
                          on
                            ? 'border-nvr-cyan/60 bg-nvr-cyan/15 text-nvr-navy dark:text-nvr-cyan'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'
                        )}
                      >
                        {d.short}
                      </button>
                    )
                  })}
                </fieldset>
              </Row>
              <Row
                label='Hours'
                htmlFor='monkey-start'
                help={`${twelveHour(draft.hours.start)} to ${twelveHour(draft.hours.end)} ${tzLabel(draft.hours.tz)}`}
              >
                <div className='flex flex-wrap items-center gap-2'>
                  <input
                    id='monkey-start'
                    type='time'
                    step={900}
                    value={draft.hours.start}
                    disabled={ro}
                    onChange={(e) => e.target.value && setHours({ start: e.target.value })}
                    className={cn(inputCls, 'w-32')}
                    aria-label='From'
                  />
                  <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>to</span>
                  <input
                    type='time'
                    step={900}
                    value={draft.hours.end}
                    disabled={ro}
                    onChange={(e) => e.target.value && setHours({ end: e.target.value })}
                    className={cn(inputCls, 'w-32')}
                    aria-label='To'
                  />
                </div>
              </Row>
              <Row label='Drills a week' htmlFor='monkey-week' help='0 pauses the monkey.'>
                <NumberBox
                  id='monkey-week'
                  value={draft.max_per_week}
                  onChange={(v) => set({ max_per_week: v ?? 0 })}
                  unit='at most'
                  min={0}
                  max={50}
                  placeholder='3'
                  disabled={ro}
                />
              </Row>
            </Section>

            <Section
              title='How small'
              help='Each drill takes a share of traffic when the fault can (else one replica), for a short while. The instance’s limits in Settings apply on top.'
            >
              <Row label='Share of traffic' htmlFor='monkey-share'>
                <NumberBox
                  id='monkey-share'
                  value={draft.max_share_pct}
                  onChange={(v) => set({ max_share_pct: v ?? 10 })}
                  unit='%'
                  min={1}
                  max={100}
                  placeholder='10'
                  disabled={ro}
                />
              </Row>
              <Row label='Drill length' htmlFor='monkey-seconds'>
                <NumberBox
                  id='monkey-seconds'
                  value={draft.max_seconds}
                  onChange={(v) => set({ max_seconds: v ?? 60 })}
                  unit='seconds at most'
                  min={5}
                  max={600}
                  placeholder='60'
                  disabled={ro}
                />
              </Row>
            </Section>

            <Section
              title='Approved faults'
              help='The monkey picks one of these at random. Faults that cannot be made small (no share, one replica of several, or low blast) are skipped.'
            >
              <div className='px-3 py-2.5'>
                {candidates.length === 0 ? (
                  <p className='px-1 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
                    No faults are registered on this instance.
                  </p>
                ) : (
                  <FaultChecklist
                    candidates={candidates}
                    value={draft.faults}
                    onChange={(faults) => set({ faults })}
                    disabled={ro}
                  />
                )}
                {draft.faults.length === 0 && (
                  <p className='mt-2 px-1 text-[12px] text-amber-800 dark:text-amber-300'>
                    Nothing approved: the monkey stays idle even when switched on.
                  </p>
                )}
              </div>
            </Section>
          </div>
          {admin && (
            <SaveBar
              dirty={dirty}
              saving={save.isPending}
              error={error}
              onSave={() => save.mutate({ ...draft, enabled: m.enabled })}
              onDiscard={() => {
                setDraft(m)
                setError(null)
              }}
            />
          )}
        </div>

        <aside
          aria-label='Last monkey runs'
          className='border-t border-slate-200 bg-white lg:w-[340px] lg:shrink-0 lg:overflow-y-auto lg:border-l lg:border-t-0 dark:border-border dark:bg-card'
        >
          <h3 className='border-b border-slate-100 px-4 py-3 text-[13px] font-semibold text-slate-900 dark:border-border/60 dark:text-foreground'>
            Last runs
          </h3>
          {data.runs.length === 0 ? (
            <p className='px-4 py-4 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              The monkey has not run here yet. Its drills land here and in Runs, each with its
              verdict.
            </p>
          ) : (
            <ul className='divide-y divide-slate-100 dark:divide-border/60'>
              {data.runs.map((r) => (
                <li key={r.id}>
                  <Link
                    to={`/chaos?tab=runs&run=${encodeURIComponent(r.id)}`}
                    className='block px-4 py-2.5 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan dark:hover:bg-muted'
                  >
                    <div className='flex items-center gap-2'>
                      <span className='min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
                        {r.label}
                      </span>
                      <RunChip run={r} />
                    </div>
                    <p className='mt-0.5 truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                      <span className='tabular-nums'>{formatRelative(r.started_at ?? r.created_at)}</span>
                      {r.status === 'refused' && refusalWhy(r) && <> · {refusalWhy(r)}</>}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  )
}

function verdictSentence(d: MonkeyView): string {
  if (d.verdict.ok)
    return `Eligible now — about a ${Math.max(1, Math.round(d.verdict.chance * 100))}% chance at each 15-minute tick, so drills spread across the week.`
  return `${d.verdict.why}.`
}

/** The first failed pre-flight check of a refused run, in its own words. */
function refusalWhy(r: { meta: Record<string, unknown> }): string | null {
  const checks = Array.isArray(r.meta.preflight)
    ? (r.meta.preflight as Array<{ ok?: boolean; why?: string | null; label?: string }>)
    : []
  const bad = checks.find((c) => c && c.ok === false)
  if (bad) return bad.why ?? bad.label ?? null
  return typeof r.meta.refusal === 'string' ? r.meta.refusal : null
}
