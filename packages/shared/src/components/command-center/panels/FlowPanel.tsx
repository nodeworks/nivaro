import { ArrowDownRight, ArrowRight, ArrowUpRight, Bell } from 'lucide-react'
import { useState } from 'react'
import { useCcQuery } from '../api'
import { useCc } from '../state'
import { FAINT, FOCUS, MUTED, PANEL, PANEL_HEAD, TITLE } from '../theme'
import type { FlowDetail } from '../types'
import { ageShort, ageWords, stateListUrl } from '../work-links'

const FALLBACK_COLOR = '#00a5cc'

/**
 * Pipeline flow (CC-5, CC-9): per workflow-bound collection the viewer reads, a stacked bar of
 * open records per state and, under it, each state's count, oldest / median time in the state
 * and how many are stuck. Every bar segment and state row opens the collection list filtered to
 * that state. The footer reads the week: open change (arrow + words), completions and "clears in".
 * Counts are the viewer's own (User Scopes, row filters) from /command-center/flow; until that
 * arrives the snapshot's counts draw the bars.
 */
export function FlowPanel() {
  const cc = useCc()
  const q = useCcQuery<FlowDetail[]>('/flow', undefined, { refetchInterval: 60_000 })
  const flow: FlowDetail[] =
    q.data ??
    (cc.snapshot?.flow ?? []).map((f) => ({
      collection: f.collection,
      collection_label: f.collection,
      template_name: f.template_name,
      states: f.states.map((s) => ({ ...s, oldest_age_s: null, median_age_s: null, stuck: 0 })),
      open: f.states.reduce((a, s) => a + s.count, 0),
      wip_7d_delta: null,
      completed_7d: 0,
      clears_in_days: null
    }))
  const liveOnly = flow.some((f) => f.live_only)
  const noRegion = !!cc.region && flow.length > 0 && flow.every((f) => f.region_applies === false)
  return (
    <section className={PANEL} data-cc-panel='flow' aria-busy={q.isLoading}>
      <div className={PANEL_HEAD}>
        <h2 className={TITLE}>Pipeline flow</h2>
        {liveOnly && <span className={`text-[11px] ${FAINT}`}>Live — can't rewind this</span>}
        {!liveOnly && noRegion && (
          <span className={`text-[11px] ${FAINT}`}>Not placed in regions — showing everywhere</span>
        )}
      </div>
      <div className='space-y-4 p-3'>
        {flow.map((f) => (
          <FlowBlock key={`${f.collection}:${f.template_name}`} f={f} />
        ))}
        {flow.length === 0 && !q.isLoading && (
          <p className={`text-[12px] ${FAINT}`}>No workflow-bound collections visible to you.</p>
        )}
      </div>
    </section>
  )
}

function FlowBlock({ f }: { f: FlowDetail }) {
  const cc = useCc()
  const [open, setOpen] = useState(false)
  const total = Math.max(
    1,
    f.states.reduce((a, s) => a + s.count, 0)
  )
  const go = (state: string | null, minAgeHours?: number) =>
    cc.navigate(stateListUrl(f.collection, { state, minAgeHours }))
  const withRecords = f.states.filter((s) => s.count > 0)
  const stuckDays = cc.config?.stuck_days ?? 7
  return (
    <div>
      <div className='mb-1 flex items-baseline justify-between gap-2'>
        <button
          type='button'
          onClick={() => go(null)}
          className={`truncate rounded text-left text-[12px] font-medium text-[var(--cc-text)] hover:underline ${FOCUS}`}
          data-tip={`Open ${f.collection_label}`}
        >
          {f.template_name}
        </button>
        <span className={`shrink-0 text-[11px] tabular-nums ${FAINT}`}>{f.open} open</span>
      </div>
      <div className='flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-[var(--cc-chip)]'>
        {withRecords.map((s) => (
          <button
            key={s.key}
            type='button'
            onClick={() => go(s.key)}
            className={`h-full transition-opacity hover:opacity-75 ${FOCUS}`}
            style={{
              width: `${Math.max(2, (s.count / total) * 100)}%`,
              background: s.color ?? FALLBACK_COLOR
            }}
            aria-label={`${s.label}: ${s.count} open. Open the list filtered to ${s.label}`}
            data-tip={`${s.label}: ${s.count} — open the list`}
          />
        ))}
      </div>
      <ul className='mt-1.5 space-y-0.5'>
        {(open ? f.states : withRecords).map((s) => (
          <li key={s.key} className='group flex items-center gap-1.5 text-[11.5px]'>
            <button
              type='button'
              onClick={() => go(s.key)}
              className={`flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 text-left hover:bg-[var(--cc-chip)] ${FOCUS}`}
              aria-label={`${s.label}: ${s.count} open, oldest ${ageWords(s.oldest_age_s)}, ${s.stuck} stuck. Open the list`}
            >
              <span
                className='h-1.5 w-1.5 shrink-0 rounded-full'
                style={{ background: s.color ?? FALLBACK_COLOR }}
                aria-hidden
              />
              <span className='min-w-0 flex-1 truncate text-[var(--cc-muted)]'>{s.label}</span>
              <b className='tabular-nums text-[var(--cc-text)]'>{s.count}</b>
              <span
                className={`w-[64px] shrink-0 text-right tabular-nums ${FAINT}`}
                data-tip={
                  s.count
                    ? `Oldest ${ageWords(s.oldest_age_s)} · median ${ageWords(s.median_age_s)}`
                    : undefined
                }
              >
                {s.count ? `${ageShort(s.oldest_age_s)} / ${ageShort(s.median_age_s)}` : ''}
              </span>
            </button>
            {s.stuck > 0 ? (
              <button
                type='button'
                onClick={() => go(s.key, stuckDays * 24)}
                className={`shrink-0 rounded px-1 text-[11px] font-medium text-[var(--cc-warn-text)] hover:underline ${FOCUS}`}
                data-tip={`In ${s.label} longer than ${stuckDays} days — open them`}
              >
                {s.stuck} stuck
              </button>
            ) : null}
            {cc.isAdmin && !cc.kiosk && s.alert_href ? (
              <button
                type='button'
                onClick={() => cc.navigate(s.alert_href as string)}
                className={`invisible shrink-0 rounded p-0.5 text-[var(--cc-faint)] hover:text-[var(--cc-text)] group-focus-within:visible group-hover:visible ${FOCUS}`}
                aria-label={`Alert me about ${s.label}`}
                data-tip='Alert me'
              >
                <Bell className='h-3 w-3' aria-hidden />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className='mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]'>
        <WeekTrend f={f} />
        {f.states.length > withRecords.length && (
          <button
            type='button'
            onClick={() => setOpen((v) => !v)}
            className={`ml-auto rounded ${MUTED} hover:underline ${FOCUS}`}
            aria-expanded={open}
          >
            {open ? 'Hide empty states' : `Show all ${f.states.length} states`}
          </button>
        )}
      </div>
    </div>
  )
}

function WeekTrend({ f }: { f: FlowDetail }) {
  const d = f.wip_7d_delta
  if (d == null && f.completed_7d === 0) return null
  const growing = d != null && d > 0
  const Icon = d == null || d === 0 ? ArrowRight : growing ? ArrowUpRight : ArrowDownRight
  const tone = growing ? 'text-[var(--cc-warn-text)]' : 'text-[var(--cc-muted)]'
  return (
    <>
      {d != null && (
        <span className={`flex items-center gap-0.5 ${tone}`}>
          <Icon className='h-3 w-3' aria-hidden />
          {d === 0 ? 'steady this week' : `${d > 0 ? '+' : '−'}${Math.abs(d)} open this week`}
        </span>
      )}
      <span className={FAINT}>{f.completed_7d} done in 7 days</span>
      <span className={growing ? 'font-medium text-[var(--cc-warn-text)]' : MUTED}>
        {growing
          ? 'growing'
          : f.clears_in_days == null
            ? 'not clearing'
            : f.clears_in_days === 0
              ? 'clear'
              : `clears in ~${Math.max(1, Math.round(f.clears_in_days))} day${
                  Math.round(f.clears_in_days) === 1 ? '' : 's'
                }`}
      </span>
    </>
  )
}
