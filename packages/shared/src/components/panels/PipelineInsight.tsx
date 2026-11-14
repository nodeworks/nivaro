import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, Hourglass } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, formatDateTime } from '../../lib/utils'

/**
 * Two pipeline-panel insights (Rob 2026-11-13):
 *  - the sign-off line — "2 of 3 signed — waiting on Ana Ruiz (Finance)" when
 *    the current step needs several sign-offs (`sign_offs` on GET
 *    /pipelines/instance, api services/sign-offs.ts);
 *  - step timing — each visit to a step split into WAITING (entry until an
 *    owner first touched it) and WORKING (first touch until it left), read
 *    lazily from GET /pipelines/instance/:c/:i/step-timing (api
 *    services/step-timing.ts) once the panel is open.
 */

export interface SignOffSummary {
  kind: 'branches' | 'chain'
  title: string | null
  required: number
  signed: number
  waiting: Array<{ label: string; names: string[]; more: number }>
  signers: Array<{ label: string; name: string | null; at: string | null }>
}

export type TouchKind = 'edit' | 'comment' | 'task' | 'view' | 'move'

export interface VisitTiming {
  history_id: number
  state: string
  entered_at: string
  left_at: string | null
  current: boolean
  waiting_ms: number
  working_ms: number
  first_touch_at: string | null
  first_touch_kind: TouchKind | null
  owners_known: boolean
}

// ─── Sign-offs ──────────────────────────────────────────────────────────────

function waitingWho(w: SignOffSummary['waiting'][number]): string {
  if (w.names.length === 0) return w.label
  const names = w.names.join(', ') + (w.more > 0 ? ` +${w.more}` : '')
  return `${names} (${w.label})`
}

/** "2 of 3 signed — waiting on Ana Ruiz (Finance)". */
export function signOffLine(s: SignOffSummary): string {
  const head = `${s.signed} of ${s.required} signed`
  if (s.waiting.length === 0) return head
  return `${head} — waiting on ${s.waiting.map(waitingWho).join(', ')}`
}

/** "Legal — Ben Ko, Nov 12, 3:00 PM" per signer, for the tip. */
export function signerText(x: SignOffSummary['signers'][number]): string {
  const who = x.name ?? 'finished on its own'
  return `${x.label} — ${who}${x.at ? `, ${formatDateTime(x.at)}` : ''}`
}

function SignOffRow({ summary }: { summary: SignOffSummary }) {
  const [open, setOpen] = useState(false)
  const tip =
    summary.signers.length > 0
      ? `Signed: ${summary.signers.map(signerText).join(' · ')}`
      : 'Nobody has signed yet'
  const pct = summary.required > 0 ? (summary.signed / summary.required) * 100 : 0
  return (
    <div data-sign-off={summary.kind}>
      <button
        type='button'
        className='group flex w-full items-center gap-2 rounded-md text-left text-[12px] text-slate-600 transition-colors hover:text-slate-800 dark:text-slate-300 dark:hover:text-slate-100'
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-tip={tip}
      >
        <span
          className='relative h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10'
          aria-hidden
        >
          <span
            className='absolute inset-y-0 left-0 rounded-full bg-emerald-500 dark:bg-emerald-400'
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className='min-w-0 flex-1 truncate' data-sign-off-line>
          {summary.title ? (
            <span className='font-medium text-slate-700 dark:text-slate-200'>
              {summary.title}:{' '}
            </span>
          ) : null}
          {signOffLine(summary)}
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150',
            open && 'rotate-180'
          )}
        />
      </button>
      {open && (
        <ul className='mt-1.5 space-y-1 pl-12 text-[11.5px]' data-sign-off-detail>
          {summary.signers.map((x) => (
            <li
              key={`s-${x.label}`}
              className='flex items-baseline gap-1.5 text-slate-600 dark:text-slate-300'
            >
              <Check
                className='h-3 w-3 shrink-0 translate-y-0.5 text-emerald-600 dark:text-emerald-400'
                strokeWidth={3}
              />
              <span className='font-medium'>{x.label}</span>
              <span className='text-slate-500 dark:text-slate-400'>
                {x.name ?? 'finished on its own'}
                {x.at ? ` · ${formatDateTime(x.at)}` : ''}
              </span>
            </li>
          ))}
          {summary.waiting.map((w) => (
            <li
              key={`w-${w.label}`}
              className='flex items-baseline gap-1.5 text-slate-500 dark:text-slate-400'
            >
              <Hourglass className='h-3 w-3 shrink-0 translate-y-0.5 text-amber-500' />
              <span className='font-medium text-slate-600 dark:text-slate-300'>{w.label}</span>
              <span>
                {w.names.length > 0
                  ? `waiting on ${w.names.join(', ')}${w.more > 0 ? ` +${w.more}` : ''}`
                  : 'waiting — nobody owns it yet'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** One line per sign-off set the current step waits on; nothing for one approver. */
export function SignOffSummaryLines({ summaries }: { summaries?: SignOffSummary[] | null }) {
  const shown = (summaries ?? []).filter((s) => s.required >= 2)
  if (shown.length === 0) return null
  return (
    <div className='space-y-1.5' data-sign-offs>
      {shown.map((s) => (
        <SignOffRow
          key={`${s.kind}:${s.title ?? ''}:${[...s.signers, ...s.waiting].map((x) => x.label).join('|')}`}
          summary={s}
        />
      ))}
    </div>
  )
}

// ─── Step timing ────────────────────────────────────────────────────────────

/** "12 min" / "3 h" / "2 d". */
export function durWords(ms: number): string {
  const m = Math.round(Math.max(0, ms) / 60_000)
  if (m < 1) return 'under a minute'
  if (m < 60) return `${m} min`
  const h = ms / 3_600_000
  if (h < 48) return `${Math.round(h)} h`
  return `${Math.round(h / 24)} d`
}

/** "waited 2 d, worked 3 h" — or what the visit was. */
export function timingWords(t: VisitTiming): string {
  const so = t.current ? ' so far' : ''
  if (!t.owners_known && t.working_ms === 0)
    return `waited ${durWords(t.waiting_ms)}${so} · nobody owns it`
  if (t.current && !t.first_touch_at)
    return `waiting ${durWords(t.waiting_ms)} so far — nobody has touched it`
  if (!t.current && t.working_ms < 60_000)
    return `waited ${durWords(t.waiting_ms)}, then moved on at once`
  if (t.working_ms < 60_000) return `waited ${durWords(t.waiting_ms)}, picked up just now`
  if (t.waiting_ms < 60_000) return `worked ${durWords(t.working_ms)}${so}, picked up at once`
  return `waited ${durWords(t.waiting_ms)}, worked ${durWords(t.working_ms)}${so}`
}

const TOUCH_WORDS: Record<TouchKind, string> = {
  edit: 'an edit',
  comment: 'a comment',
  task: 'a task',
  view: 'opening the record',
  move: 'the move on'
}

/** "First touched by an owner with a comment, Nov 12, 3:00 PM". */
export function firstTouchText(t: VisitTiming): string | null {
  if (!t.first_touch_at || !t.first_touch_kind) return null
  return `First touched by an owner with ${TOUCH_WORDS[t.first_touch_kind]}, ${formatDateTime(t.first_touch_at)}`
}

/**
 * The record's step timing, by the history row that entered each visit.
 * Lazy: only mounted surfaces (the open panel's bar and history) ask, and
 * `version` (newest history id + completion) refetches after a move.
 */
export function useStepTiming(
  collection: string,
  item: string,
  version: string,
  enabled = true
): Map<number, VisitTiming> | null {
  const client = useNivaroClient()
  const { data } = useQuery<VisitTiming[]>({
    queryKey: ['pipeline-step-timing', collection, item, version],
    queryFn: () =>
      client
        .request<{ data: VisitTiming[] }>(
          get(`/pipelines/instance/${collection}/${item}/step-timing`)
        )
        .then((r) => r.data ?? []),
    enabled,
    staleTime: 60_000
  })
  if (!data) return null
  return new Map(data.map((t) => [Number(t.history_id), t]))
}

/** Waiting stripes over the step colour; working is the solid tone. */
export function waitingFill(color: string | null): string {
  const c = color ?? '#64748b'
  return `repeating-linear-gradient(135deg, ${c}2e 0 4px, ${c}14 4px 8px)`
}
export function workingFill(color: string | null): string {
  return color ? `${color}77` : 'rgba(100,116,139,.45)'
}

/** The bar's key: hatched = waiting, solid = working. */
export function TimingLegend() {
  return (
    <span className='flex items-center gap-2' data-step-timing-legend>
      <span className='flex items-center gap-1'>
        <span
          className='inline-block h-2 w-3 rounded-sm'
          style={{ background: waitingFill('#64748b') }}
        />
        Waiting
      </span>
      <span className='flex items-center gap-1'>
        <span
          className='inline-block h-2 w-3 rounded-sm'
          style={{ background: workingFill('#64748b') }}
        />
        Working
      </span>
    </span>
  )
}
