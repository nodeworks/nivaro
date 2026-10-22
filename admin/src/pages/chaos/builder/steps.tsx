import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Plus, RotateCcw, X } from 'lucide-react'
import { type CSSProperties, type ReactNode, useEffect, useId, useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { UserCombobox } from '@/components/user-combobox'
import { api, type User } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { CatalogFault, FaultTarget, HypothesisRule } from '../api'
import { DANGER_CHIP } from '../ops-controls'
import { PreflightPanel } from '../PreflightPanel'
import { builderKeys, fetchBlast, fetchSamplers } from './api'
import {
  ABORT_AFTER_MAX,
  ABORT_AFTER_MIN,
  abortLine,
  BUILTIN_SAMPLERS,
  type ChaosCaps,
  clampAbortAfter,
  type DraftSpec,
  emptyTarget,
  faultAllowed,
  formatSeconds,
  mapNodeFor,
  maxSeconds,
  maxShare,
  type ParamValue,
  paramRange,
  SAMPLE_EVERY_S,
  shareCapNarrowsAll,
  TARGET_LABEL,
  withUnit
} from './model'
import { ChoiceCombobox, RouteCombobox, TableCombobox } from './pickers'

/** The builder's step bodies (#2844). Each gets the draft and a setter; none fetch to write. */

export const inputCls =
  'h-8 rounded-md border border-slate-200 bg-white px-2 text-[12.5px] tabular-nums text-slate-900 placeholder:text-slate-500 focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
export const labelCls = 'text-[12px] font-medium text-slate-700 dark:text-foreground/90'
const hintCls = 'text-[12px] text-slate-500 dark:text-muted-foreground'
const rangeCls = 'nvr-builder-range w-full'

/**
 * The builder's sliders, drawn by hand: Chrome's native track ignores accent-color for the unfilled
 * part (near-black in light mode). Same look as the shared chaos toolbar's slider: slate track,
 * cyan fill up to the value (--nvr-range-fill), white thumb ringed in cyan, a focus halo.
 */
const RANGE_CSS = `
.nvr-builder-range { -webkit-appearance: none; appearance: none; height: 16px; background: transparent; cursor: pointer; --nvr-range-track: rgb(226 232 240) }
.dark .nvr-builder-range { --nvr-range-track: rgb(255 255 255 / 0.14) }
.nvr-builder-range::-webkit-slider-runnable-track { height: 4px; border-radius: 9999px; background: linear-gradient(to right, rgb(var(--nvr-cyan-rgb, 0 206 255)) 0 var(--nvr-range-fill, 0%), var(--nvr-range-track) var(--nvr-range-fill, 0%) 100%) }
.nvr-builder-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 14px; margin-top: -5px; border-radius: 9999px; background: #fff; border: 2px solid rgb(var(--nvr-cyan-rgb, 0 206 255)); box-shadow: 0 1px 2px rgb(0 0 0 / 0.15) }
.nvr-builder-range::-moz-range-track { height: 4px; border-radius: 9999px; background: var(--nvr-range-track) }
.nvr-builder-range::-moz-range-progress { height: 4px; border-radius: 9999px; background: rgb(var(--nvr-cyan-rgb, 0 206 255)) }
.nvr-builder-range::-moz-range-thumb { width: 10px; height: 10px; border-radius: 9999px; background: #fff; border: 2px solid rgb(var(--nvr-cyan-rgb, 0 206 255)) }
.nvr-builder-range:focus-visible { outline: none }
.nvr-builder-range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px rgb(var(--nvr-cyan-rgb, 0 206 255) / 0.35) }
.nvr-builder-range:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 3px rgb(var(--nvr-cyan-rgb, 0 206 255) / 0.35) }
`

type SetDraft = (fn: (d: DraftSpec) => DraftSpec) => void

export interface StepProps {
  fault: CatalogFault
  draft: DraftSpec
  set: SetDraft
  caps: ChaosCaps | null
}

/** A row of mutually exclusive choices (radio semantics, keyboard via Tab + Space). */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  mono
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  ariaLabel: string
  mono?: boolean
}) {
  return (
    <div
      role='radiogroup'
      aria-label={ariaLabel}
      className='inline-flex flex-wrap gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          // biome-ignore lint/a11y/useSemanticElements: a segmented control of buttons, same pattern as SecurityCenter
          <button
            key={o.value}
            type='button'
            role='radio'
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-7 min-w-8 px-2.5 text-[12px] font-medium transition-colors duration-150 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
              mono && 'font-mono',
              on
                ? 'bg-nvr-cyan/10 text-slate-900 dark:bg-nvr-cyan/15 dark:text-foreground'
                : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-card dark:text-muted-foreground dark:hover:bg-muted'
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

const clampTo = (n: number, lo: number, hi: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo

/** Slider + number box for one bounded number. */
function NumberDial({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  capped,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  capped?: string | null
  onChange: (n: number) => void
}) {
  const id = `dial-${label.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <div className='space-y-1.5'>
      <div className='flex items-baseline justify-between gap-3'>
        <label htmlFor={id} className={labelCls}>
          {label}
        </label>
        <span className='text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'>
          {withUnit(`${min}–${max}`, unit)}
          {capped ? ` · ${capped}` : ''}
        </span>
      </div>
      <div className='flex items-center gap-3'>
        <style>{RANGE_CSS}</style>
        <input
          type='range'
          aria-label={label}
          className={rangeCls}
          style={
            {
              '--nvr-range-fill': `${((clampTo(value, min, max) - min) / (max - min || 1)) * 100}%`
            } as CSSProperties
          }
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <div className='flex shrink-0 items-center gap-1.5'>
          <input
            id={id}
            type='number'
            className={cn(inputCls, 'w-24 text-right')}
            min={min}
            max={max}
            step={step}
            value={Number.isFinite(value) ? value : ''}
            onChange={(e) => onChange(Number(e.target.value))}
            onBlur={(e) => {
              const n = Number(e.target.value)
              onChange(Math.min(max, Math.max(min, Number.isFinite(n) ? n : min)))
            }}
          />
          {unit && (
            <span className='w-8 text-[12px] text-slate-500 dark:text-muted-foreground'>
              {unit}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export function StepHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className='mb-4'>
      <h3 className='text-[14px] font-semibold text-slate-900 [text-wrap:balance] dark:text-foreground'>
        {title}
      </h3>
      {children && <p className={cn(hintCls, 'mt-0.5 max-w-[70ch] text-[12.5px]')}>{children}</p>}
    </div>
  )
}

// ─── 1. Fault ──────────────────────────────────────────────────────────────────

export function FaultStep({
  fault,
  faults,
  caps,
  onPick
}: {
  fault: CatalogFault
  faults: CatalogFault[]
  caps: ChaosCaps | null
  onPick: (key: string) => void
}) {
  return (
    <div>
      <StepHeading title='Which fault'>
        Each fault proves one claim about how Nivaro degrades. Changing it starts the draft again
        from that fault's defaults.
      </StepHeading>
      <div className='max-w-md'>
        <ChoiceCombobox
          ariaLabel='Fault'
          value={fault.key}
          onChange={onPick}
          choices={faults.map((f) => ({
            value: f.key,
            label: f.label,
            hint: faultAllowed(f, caps) ? (f.area ?? undefined) : 'not allowed here'
          }))}
          searchPlaceholder='Search faults…'
        />
      </div>
      <div className='mt-4 space-y-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='font-mono text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {fault.key}
          </span>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[11px] font-medium',
              DANGER_CHIP[fault.danger] ?? DANGER_CHIP.low
            )}
          >
            {fault.danger === 'low' ? 'Low' : fault.danger === 'medium' ? 'Medium' : 'High'} blast
          </span>
          <span className={hintCls}>up to {formatSeconds(fault.max_seconds)} per run</span>
        </div>
        <p className='max-w-[70ch] text-[13px] text-slate-700 dark:text-foreground/90'>
          {fault.proves}
        </p>
        {fault.points.length > 0 && (
          <p className={hintCls}>
            Acts at <span className='font-mono text-[11.5px]'>{fault.points.join(', ')}</span>
          </p>
        )}
        {!faultAllowed(fault, caps) && (
          <p className='flex items-center gap-1.5 text-[12.5px] text-amber-800 dark:text-amber-300'>
            <AlertTriangle className='h-3.5 w-3.5 shrink-0' aria-hidden />
            This environment's chaos settings do not allow this fault. Pick another one.
          </p>
        )}
      </div>
    </div>
  )
}

// ─── 2. Target ─────────────────────────────────────────────────────────────────

const TARGET_HINT: Record<FaultTarget['kind'], string> = {
  all: 'Everything passing the fault points on every replica.',
  route: 'Requests whose path matches a pattern; * matches one segment or the rest.',
  table: 'Database work on one table.',
  user: "One person's requests and sockets — handy for testing on yourself.",
  share: 'A fixed share, picked by a stable hash so one request is in or out for the whole run.',
  node: 'Only one API replica; the others carry on.',
  room: 'One socket room.'
}

export function TargetStep({ fault, draft, set, caps, nodes }: StepProps & { nodes: string[] }) {
  const t = draft.target
  const { data: users } = useQuery<User[]>({
    queryKey: ['users', 'combobox'],
    queryFn: () => api.get<{ data: User[] }>('/users?limit=200').then((r) => r.data.data),
    enabled: t.kind === 'user'
  })
  const setTarget = (next: FaultTarget) => set((d) => ({ ...d, target: next }))
  const narrowsAll = shareCapNarrowsAll(fault, caps)
  const replicaCap =
    caps?.max_replicas != null && nodes.length > caps.max_replicas && t.kind !== 'node'
  return (
    <div>
      <StepHeading title='Who it reaches'>
        Start narrow. A run can only reach what this fault accepts.
      </StepHeading>
      <div
        role='radiogroup'
        aria-label='Target'
        className='grid gap-2 sm:grid-cols-2 xl:grid-cols-3'
      >
        {fault.targets.map((k) => {
          const on = t.kind === k
          const capped = k === 'all' && narrowsAll
          return (
            // biome-ignore lint/a11y/useSemanticElements: a segmented control of buttons, same pattern as SecurityCenter
            <button
              key={k}
              type='button'
              role='radio'
              aria-checked={on}
              disabled={capped}
              onClick={() => !on && setTarget(emptyTarget(k, nodes))}
              className={cn(
                'flex flex-col items-start justify-start rounded-md border px-3 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                // A capped choice stays readable (its hint says why); only the title dims.
                capped
                  ? 'cursor-not-allowed border-dashed border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/30'
                  : on
                    ? 'border-nvr-cyan bg-nvr-cyan/5 dark:bg-nvr-cyan/10'
                    : 'border-slate-200 bg-white hover:border-slate-300 dark:border-border dark:bg-card dark:hover:border-slate-600'
              )}
            >
              <span
                className={cn(
                  'block text-[12.5px] font-medium',
                  capped
                    ? 'text-slate-500 dark:text-muted-foreground'
                    : 'text-slate-900 dark:text-foreground'
                )}
              >
                {TARGET_LABEL[k]}
              </span>
              <span
                className={cn(
                  'mt-0.5 block text-[11.5px] leading-snug',
                  capped
                    ? 'text-amber-800 dark:text-amber-300'
                    : 'text-slate-500 dark:text-muted-foreground'
                )}
              >
                {capped
                  ? `This environment caps a run at ${maxShare(caps)}% of traffic.`
                  : TARGET_HINT[k]}
              </span>
            </button>
          )
        })}
      </div>

      {replicaCap && (
        <p className={cn(hintCls, 'mt-3 max-w-[70ch]')}>
          This environment lets one run reach {caps?.max_replicas} of {nodes.length} replicas: the
          server narrows a wider run to the replica that starts it, or refuses it.
        </p>
      )}
      <div className='mt-4 max-w-md'>
        {t.kind === 'route' && (
          <div className='space-y-1'>
            <span className={labelCls}>Route pattern</span>
            <RouteCombobox
              value={t.pattern}
              onChange={(v) => setTarget({ kind: 'route', pattern: v })}
            />
            <p className={hintCls}>From the Traffic Map's last 15 minutes, busiest first.</p>
          </div>
        )}
        {t.kind === 'table' && (
          <div className='space-y-1'>
            <span className={labelCls}>Table</span>
            <TableCombobox
              value={t.table}
              onChange={(v) => setTarget({ kind: 'table', table: v })}
            />
          </div>
        )}
        {t.kind === 'user' && (
          <div className='space-y-1'>
            <span className={labelCls}>Person</span>
            <UserCombobox
              value={t.user_id || null}
              placeholder='Pick a person…'
              noneLabel='Nobody'
              onChange={(id) => {
                const u = (users ?? []).find((x) => x.id === id)
                const name = u
                  ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
                  : null
                setTarget({ kind: 'user', user_id: id ?? '', name })
              }}
            />
          </div>
        )}
        {t.kind === 'share' && (
          <NumberDial
            label='Share of traffic'
            value={t.share_pct}
            min={1}
            max={maxShare(caps)}
            unit='%'
            capped={caps?.max_share_pct != null ? 'this environment’s cap' : null}
            onChange={(n) => setTarget({ kind: 'share', share_pct: n })}
          />
        )}
        {t.kind === 'node' && (
          <div className='space-y-1'>
            <span className={labelCls}>Replica</span>
            {nodes.length ? (
              <ChoiceCombobox
                ariaLabel='Replica'
                value={t.node}
                onChange={(v) => setTarget({ kind: 'node', node: v })}
                choices={nodes.map((n) => ({ value: n, label: n, mono: true }))}
              />
            ) : (
              <p className={hintCls}>No replica has reported in yet. Reload in a moment.</p>
            )}
          </div>
        )}
        {t.kind === 'room' && (
          <label className='block space-y-1'>
            <span className={labelCls}>Room</span>
            <input
              className={cn(inputCls, 'w-full font-mono text-[12px]')}
              value={t.room}
              placeholder='collection:articles'
              onChange={(e) => setTarget({ kind: 'room', room: e.target.value })}
            />
          </label>
        )}
      </div>
    </div>
  )
}

// ─── 3. Strength ───────────────────────────────────────────────────────────────

export function StrengthStep({ fault, draft, set, caps }: StepProps) {
  const entries = Object.entries(fault.params)
  const setParam = (k: string, v: ParamValue) =>
    set((d) => ({ ...d, params: { ...d.params, [k]: v } }))
  return (
    <div>
      <StepHeading title='How hard'>
        The sliders stop at the catalog's caps{caps ? ' and this environment’s limits' : ''}; the
        server enforces them again whatever is sent.
      </StepHeading>
      {entries.length === 0 ? (
        <p className={cn(hintCls, 'text-[12.5px]')}>
          This fault has no strength setting: while it is armed it is fully on.
        </p>
      ) : (
        <div className='grid max-w-2xl gap-5'>
          {entries.map(([k, s]) => {
            const v = draft.params[k]
            if (s.type === 'number') {
              const [lo, hi] = paramRange(s, caps)
              return (
                <NumberDial
                  key={k}
                  label={s.label}
                  value={Number(v)}
                  min={lo}
                  max={hi}
                  step={s.step ?? (hi - lo > 1000 ? 50 : 1)}
                  unit={s.unit}
                  capped={hi < s.max ? 'capped here' : null}
                  onChange={(n) => setParam(k, n)}
                />
              )
            }
            if (s.type === 'enum')
              return (
                <div key={k} className='space-y-1.5'>
                  <span className={labelCls}>{s.label}</span>
                  <div>
                    <Segmented
                      ariaLabel={s.label}
                      value={String(v)}
                      options={s.options.map((o) => ({ value: o, label: o }))}
                      onChange={(o) => setParam(k, o)}
                    />
                  </div>
                </div>
              )
            if (s.type === 'boolean')
              return (
                <div key={k} className='flex items-center gap-3'>
                  <Switch
                    id={`param-${k}`}
                    checked={v === true}
                    onCheckedChange={(c) => setParam(k, c)}
                    className='data-[state=checked]:bg-nvr-cyan'
                  />
                  <label htmlFor={`param-${k}`} className={labelCls}>
                    {s.label}
                  </label>
                </div>
              )
            return (
              <label key={k} className='block max-w-md space-y-1'>
                <span className={labelCls}>{s.label}</span>
                <input
                  className={cn(inputCls, 'w-full')}
                  value={String(v ?? '')}
                  maxLength={s.max_length}
                  onChange={(e) => setParam(k, e.target.value)}
                />
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── 4. Duration ───────────────────────────────────────────────────────────────

const QUICK = [15, 30, 60, 120, 300, 600]

export function DurationStep({ fault, draft, set, caps }: StepProps) {
  const max = maxSeconds(fault, caps)
  const ends = new Date(Date.now() + draft.seconds * 1000)
  return (
    <div>
      <StepHeading title='How long'>
        The fault ends by itself when the time is up, even if nobody presses Stop.
      </StepHeading>
      <div className='max-w-2xl space-y-3'>
        <NumberDial
          label='Duration'
          value={draft.seconds}
          min={5}
          max={max}
          unit='s'
          capped={max < fault.max_seconds ? 'capped here' : null}
          onChange={(n) => set((d) => ({ ...d, seconds: n }))}
        />
        <div className='flex flex-wrap gap-1.5'>
          {QUICK.filter((q) => q <= max).map((q) => (
            <button
              key={q}
              type='button'
              aria-pressed={draft.seconds === q}
              onClick={() => set((d) => ({ ...d, seconds: q }))}
              className={cn(
                'h-7 rounded-md border px-2.5 text-[12px] font-medium tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                draft.seconds === q
                  ? 'border-nvr-cyan bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-muted-foreground dark:hover:bg-muted'
              )}
            >
              {formatSeconds(q)}
            </button>
          ))}
        </div>
        <p className={hintCls}>
          Started now it would end at{' '}
          <span className='tabular-nums'>
            {ends.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </span>
          .
        </p>
      </div>
    </div>
  )
}

// ─── 5. Steady-state hypothesis ────────────────────────────────────────────────

const OPS: Array<{ value: HypothesisRule['op']; label: string }> = [
  { value: '<', label: '<' },
  { value: '<=', label: '≤' },
  { value: '>', label: '>' },
  { value: '>=', label: '≥' }
]

export function useSamplerChoices() {
  const { data } = useQuery({
    queryKey: builderKeys.samplers,
    queryFn: fetchSamplers,
    staleTime: 5 * 60_000,
    retry: false
  })
  return data?.length ? data : BUILTIN_SAMPLERS
}

export function HypothesisStep({ fault, draft, set }: StepProps) {
  const samplers = useSamplerChoices()
  const unitOf = (k: string) => samplers.find((s) => s.key === k)?.unit ?? ''
  const setRule = (i: number, patch: Partial<HypothesisRule>) =>
    set((d) => ({
      ...d,
      hypothesis: d.hypothesis.map((r, j) => (j === i ? { ...r, ...patch } : r))
    }))
  return (
    <div>
      <StepHeading title='What should stay true'>
        The steady state the run must keep. Each line is checked every {SAMPLE_EVERY_S} seconds
        while the fault is armed; the verdict is held or broke.
      </StepHeading>
      {draft.hypothesis.length === 0 && (
        <p className={cn(hintCls, 'mb-3 text-[12.5px]')}>
          No lines: the run records what happened and never aborts on its own.
        </p>
      )}
      <ul className='max-w-2xl space-y-2'>
        {draft.hypothesis.map((r, i) => (
          <li
            key={`${i}-${r.sampler}`}
            className='flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white p-2 dark:border-border dark:bg-card'
          >
            <div className='min-w-[180px] flex-1'>
              <ChoiceCombobox
                ariaLabel='Sampler'
                value={r.sampler}
                onChange={(v) => setRule(i, { sampler: v })}
                choices={samplers.map((s) => ({
                  value: s.key,
                  label: s.label,
                  hint: s.key,
                  hintMono: true
                }))}
                searchPlaceholder='Search samplers…'
                allowCustom={(t) => /^[\w.-]{1,60}$/.test(t)}
              />
            </div>
            <Segmented
              ariaLabel='Comparison'
              mono
              value={r.op}
              options={OPS}
              onChange={(op) => setRule(i, { op })}
            />
            <div className='flex items-center gap-1.5'>
              <input
                type='number'
                aria-label='Limit'
                className={cn(inputCls, 'w-24 text-right')}
                value={Number.isFinite(r.limit) ? r.limit : ''}
                onChange={(e) => setRule(i, { limit: Number(e.target.value) })}
              />
              <span className='w-14 truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
                {unitOf(r.sampler)}
              </span>
            </div>
            <button
              type='button'
              aria-label='Remove this line'
              data-tip='Remove this line'
              onClick={() =>
                set((d) => ({ ...d, hypothesis: d.hypothesis.filter((_, j) => j !== i) }))
              }
              className='ml-auto rounded p-1.5 text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
            >
              <X className='h-3.5 w-3.5' aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <div className='mt-3 flex flex-wrap items-center gap-4'>
        <button
          type='button'
          onClick={() =>
            set((d) => ({
              ...d,
              hypothesis: [
                ...d.hypothesis,
                { sampler: 'http.p95_ms', op: '<', limit: 2000, tolerance: 500 }
              ]
            }))
          }
          className='inline-flex items-center gap-1 rounded-sm text-[12.5px] font-medium text-slate-700 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-foreground/90 dark:hover:text-foreground'
        >
          <Plus className='h-3.5 w-3.5' aria-hidden /> Add a line
        </button>
        {fault.hypothesis_defaults.length > 0 && (
          <button
            type='button'
            onClick={() =>
              set((d) => ({ ...d, hypothesis: fault.hypothesis_defaults.map((r) => ({ ...r })) }))
            }
            className='inline-flex items-center gap-1 rounded-sm text-[12.5px] text-slate-500 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:text-foreground'
          >
            <RotateCcw className='h-3.5 w-3.5' aria-hidden /> The fault's defaults
          </button>
        )}
      </div>
    </div>
  )
}

// ─── 6. Abort limits ───────────────────────────────────────────────────────────

const OP_WORD: Record<HypothesisRule['op'], string> = {
  '<': 'reaches',
  '<=': 'passes',
  '>': 'falls to',
  '>=': 'falls below'
}

export function AbortStep({ draft, set }: StepProps) {
  const samplers = useSamplerChoices()
  const labelOf = (k: string) => samplers.find((s) => s.key === k)?.label ?? k
  const unitOf = (k: string) => samplers.find((s) => s.key === k)?.unit ?? ''
  const n = clampAbortAfter(draft.abort_after)
  return (
    <div>
      <StepHeading title='When to stop early'>
        A line that is broken but still within its tolerance only marks the verdict. Past the
        tolerance for {n} sample{n === 1 ? '' : 's'} in a row the run aborts and every replica
        disarms the fault.
      </StepHeading>
      {draft.hypothesis.length === 0 ? (
        <p className={cn(hintCls, 'text-[12.5px]')}>
          Nothing to abort on: add a line under What stays true. The run still ends at its duration,
          on Stop and on Stop all.
        </p>
      ) : (
        <>
          <AbortAfterControl
            value={draft.abort_after}
            onChange={(v) => set((d) => ({ ...d, abort_after: v }))}
          />
          <ul className='max-w-2xl divide-y divide-slate-200 rounded-md border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
            {draft.hypothesis.map((r, i) => (
              <li
                key={`${i}-${r.sampler}`}
                className='flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5'
              >
                <div className='min-w-0 flex-1 basis-56 text-[12.5px] text-slate-700 dark:text-foreground/90'>
                  Abort if <span className='font-medium'>{labelOf(r.sampler)}</span> {OP_WORD[r.op]}{' '}
                  <span className='font-medium tabular-nums'>
                    {withUnit(abortLine(r), unitOf(r.sampler))}
                  </span>
                </div>
                <label className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-muted-foreground'>
                  Tolerance
                  <input
                    type='number'
                    min={0}
                    className={cn(inputCls, 'w-20 text-right')}
                    value={r.tolerance ?? 0}
                    onChange={(e) =>
                      set((d) => ({
                        ...d,
                        hypothesis: d.hypothesis.map((x, j) =>
                          j === i
                            ? { ...x, tolerance: Math.max(0, Number(e.target.value) || 0) }
                            : x
                        )
                      }))
                    }
                  />
                  <span className='w-12 truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
                    {unitOf(r.sampler)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * How many bad samples in a row abort the run (POST /chaos/runs `abort_after`, 1–10). One sentence
 * with the number inside it, then what that means in time: lower stops sooner, higher rides out a
 * short spike.
 */
function AbortAfterControl({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const hintId = useId()
  const [text, setText] = useState(String(value))
  // Follow outside changes (a preset, a deep link) without fighting the person typing.
  useEffect(() => {
    setText((t) => (Number(t) === value ? t : String(value)))
  }, [value])
  const n = clampAbortAfter(value)
  const commit = (raw: string) => {
    setText(raw)
    const v = Number(raw)
    if (raw.trim() !== '' && Number.isInteger(v) && v >= ABORT_AFTER_MIN && v <= ABORT_AFTER_MAX)
      onChange(v)
  }
  return (
    <div className='mb-3 max-w-2xl'>
      <label className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-slate-700 dark:text-foreground/90'>
        Stop after
        <input
          type='number'
          inputMode='numeric'
          min={ABORT_AFTER_MIN}
          max={ABORT_AFTER_MAX}
          step={1}
          aria-describedby={hintId}
          className={cn(inputCls, 'w-16 text-right')}
          value={text}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => {
            const v = clampAbortAfter(text)
            setText(String(v))
            onChange(v)
          }}
        />
        bad sample{n === 1 ? '' : 's'} in a row
      </label>
      <p id={hintId} className={cn(hintCls, 'mt-1')}>
        A sample is taken every {SAMPLE_EVERY_S} seconds, so this is about{' '}
        <span className='tabular-nums'>{n * SAMPLE_EVERY_S} seconds</span> of trouble. Lower stops
        sooner; higher rides out a short spike. From {ABORT_AFTER_MIN} to {ABORT_AFTER_MAX}; 3 suits
        most drills.
      </p>
    </div>
  )
}

// ─── 7. Blast radius ───────────────────────────────────────────────────────────

export function BlastStep({ fault, draft }: Omit<StepProps, 'set' | 'caps'>) {
  const node = mapNodeFor(fault, draft.params)
  const { data, isLoading, isError } = useQuery({
    queryKey: builderKeys.blast(node ?? '-'),
    queryFn: () => fetchBlast(node as string),
    enabled: !!node,
    staleTime: 5 * 60_000,
    retry: false
  })
  const partial = draft.target.kind !== 'all' || Object.keys(fault.params).length > 0
  return (
    <div>
      <StepHeading title='What it could touch'>
        Worked out from the last 24 hours of recorded traffic as if the whole dependency went down.
        Nothing is injected to answer this.
      </StepHeading>
      {!node ? (
        <p className={cn(hintCls, 'max-w-[70ch] text-[12.5px]')}>
          No estimate: this fault does not take a whole dependency down, so the Traffic Map has
          nothing to simulate. Its reach is the target you chose.
        </p>
      ) : isLoading ? (
        <div className='max-w-2xl space-y-2'>
          <Skeleton className='h-4 w-72' />
          <Skeleton className='h-4 w-full' />
          <Skeleton className='h-4 w-5/6' />
        </div>
      ) : isError ? (
        <p className={cn(hintCls, 'text-[12.5px]')}>The estimate did not answer. It is optional.</p>
      ) : !data ? (
        <p className={cn(hintCls, 'max-w-[70ch] text-[12.5px]')}>
          No estimate: this server's Traffic Map cannot simulate{' '}
          <span className='font-mono text-[11.5px]'>{node}</span> going down yet.
        </p>
      ) : (
        <div className='max-w-3xl space-y-4'>
          <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-border dark:bg-border'>
            {[
              ['Routes', String(data.totals.routes)],
              ['Calls a minute', data.totals.per_min.toLocaleString()],
              [
                'Share of calls',
                data.totals.share_of_calls == null
                  ? '—'
                  : `${Math.round(data.totals.share_of_calls * 1000) / 10}%`
              ],
              ['Screens · jobs', `${data.totals.screens} · ${data.totals.jobs}`]
            ].map(([k, v]) => (
              <div key={k} className='bg-white px-3 py-2 dark:bg-card'>
                <div className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>{k}</div>
                <div className='text-[14px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
                  {v}
                </div>
              </div>
            ))}
          </div>
          {partial && (
            <p className={hintCls}>
              This run is narrower than a full outage ({fault.label.toLowerCase()} on the target you
              chose), so the real reach is a part of this.
            </p>
          )}
          {data.routes.length > 0 && (
            <div>
              <div className={cn(labelCls, 'mb-1')}>Busiest affected routes</div>
              <ul className='space-y-0.5'>
                {data.routes.slice(0, 6).map((r) => (
                  <li key={r.route} className='flex items-baseline gap-3 text-[12px]'>
                    <span className='min-w-0 flex-1 truncate font-mono text-slate-700 dark:text-foreground/90'>
                      {r.route}
                    </span>
                    <span className='shrink-0 tabular-nums text-slate-500 dark:text-muted-foreground'>
                      {r.per_min}/min{r.strength === 'indirect' ? ' · indirect' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ClaimList
            title='Stops working'
            items={data.claims.fails}
            tone='text-orange-700 dark:text-orange-400'
          />
          <ClaimList
            title='Keeps working, worse'
            items={data.claims.degrades}
            tone='text-amber-700 dark:text-amber-400'
          />
          <ClaimList
            title='Unaffected'
            items={data.claims.keeps}
            tone='text-emerald-700 dark:text-emerald-400'
          />
        </div>
      )}
    </div>
  )
}

function ClaimList({
  title,
  items,
  tone
}: {
  title: string
  items: Array<{ text: string }>
  tone: string
}) {
  if (!items.length) return null
  return (
    <div>
      <div className={cn('mb-1 text-[12px] font-medium', tone)}>{title}</div>
      <ul className='list-disc space-y-0.5 pl-4 text-[12.5px] text-slate-700 marker:text-slate-400 dark:text-foreground/90'>
        {items.map((c) => (
          <li key={c.text} className='max-w-[75ch]'>
            {c.text}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─── 8. Pre-flight ─────────────────────────────────────────────────────────────

export function PreflightStep({
  serverChecks
}: {
  serverChecks: Parameters<typeof PreflightPanel>[0]['serverChecks']
}) {
  return (
    <div>
      <StepHeading title='Pre-flight'>
        Every tick must be green before Run. The server runs the same checks again when the run
        starts.
      </StepHeading>
      <div className='max-w-xl'>
        <PreflightPanel serverChecks={serverChecks} />
      </div>
    </div>
  )
}
