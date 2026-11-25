import { Plus, X } from 'lucide-react'
import { useId, useState } from 'react'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { ghostButton, smallButton } from '../hub-parts'
import {
  type AutoRule,
  METRIC_DEFAULTS,
  METRIC_WORDS,
  type Metric,
  ROLE_WORDS,
  type RoleView,
  type ScaleSchedule
} from './scale-api'

/**
 * One role's autoscaling rule, edited inline under its row: on/off, min and max replicas, the
 * figures it judges (scale out above, in below — the server refuses an "in" mark that is not
 * below the "out" one), how long a figure must hold, cooldowns, the step, and schedule windows
 * that raise the floor (weekdays 7 AM–7 PM in New York: at least 4).
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DEFAULT_ZONE = 'America/New_York'

const numInput = 'h-8 w-20 text-[13px] tabular-nums'

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  hint
}: {
  label: string
  value: number
  onChange: (n: number) => void
  min: number
  max: number
  step?: number
  unit?: string
  hint?: string
}) {
  const id = useId()
  return (
    <div className='min-w-0'>
      <label htmlFor={id} className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
        {label}
      </label>
      <span className='mt-1 flex items-center gap-1.5'>
        <Input
          id={id}
          type='number'
          inputMode='decimal'
          className={numInput}
          value={Number.isFinite(value) ? value : ''}
          min={min}
          max={max}
          step={step ?? 1}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        {unit && (
          <span className='whitespace-nowrap text-[11px] text-slate-500 dark:text-muted-foreground'>
            {unit}
          </span>
        )}
      </span>
      {hint && (
        <span id={`${id}-hint`} className='sr-only'>
          {hint}
        </span>
      )}
    </div>
  )
}

export function RuleEditor({
  role,
  saving,
  onSave,
  onClear,
  onCancel
}: {
  role: RoleView
  saving: boolean
  onSave: (rule: AutoRule) => void
  onClear: (() => void) | null
  onCancel: () => void
}) {
  const [rule, setRule] = useState<AutoRule>(() =>
    role.auto ? structuredClone(role.auto) : starter(role)
  )
  const uid = useId()
  const set = (patch: Partial<AutoRule>) => setRule((r) => ({ ...r, ...patch }))
  const unused = role.metrics.filter((m) => !rule.metrics.some((x) => x.metric === m))
  const hysteresisBad = rule.metrics.find((m) => !(m.in_below < m.out_above))

  return (
    <div className='space-y-4 border-t border-slate-200 bg-slate-50/70 px-4 py-4 dark:border-border dark:bg-muted/30'>
      <div className='flex flex-wrap items-center gap-3'>
        <Switch
          id={`${uid}-on`}
          checked={rule.enabled}
          onCheckedChange={(v) => set({ enabled: v })}
        />
        <label
          htmlFor={`${uid}-on`}
          className='text-[13px] font-medium text-slate-800 dark:text-foreground'
        >
          Autoscale {ROLE_WORDS[role.role].toLowerCase()}
        </label>
        <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Off keeps the rule but changes nothing.
        </span>
      </div>

      <div className='flex flex-wrap gap-x-6 gap-y-3'>
        <NumberField
          label='At least'
          value={rule.min}
          min={role.min}
          max={10}
          unit='replicas'
          onChange={(n) => set({ min: n })}
        />
        <NumberField
          label='At most'
          value={rule.max}
          min={rule.min}
          max={10}
          unit='replicas'
          onChange={(n) => set({ max: n })}
        />
        {role.role !== 'realtime' && (
          <NumberField
            label='Step'
            value={rule.step}
            min={1}
            max={3}
            unit='at a time'
            onChange={(n) => set({ step: n })}
          />
        )}
      </div>

      <fieldset className='m-0 min-w-0 border-0 p-0'>
        <legend className='mb-2 text-[12px] font-medium text-slate-700 dark:text-foreground'>
          Figures it judges
        </legend>
        {rule.metrics.length === 0 && (
          <p className='m-0 mb-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
            No figure yet: the rule only keeps the floor its schedules set.
          </p>
        )}
        <ul className='m-0 list-none space-y-2 p-0'>
          {rule.metrics.map((m, i) => {
            const w = METRIC_WORDS[m.metric]
            const bad = !(m.in_below < m.out_above)
            const put = (patch: Partial<typeof m>) =>
              set({ metrics: rule.metrics.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
            return (
              <li
                key={m.metric}
                className='flex flex-wrap items-end gap-x-4 gap-y-2 rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'
              >
                <span className='w-full text-[12px] font-medium text-slate-800 sm:w-44 sm:pb-2 dark:text-foreground'>
                  {w.label}
                </span>
                <NumberField
                  label='Scale out above'
                  value={m.out_above}
                  min={0}
                  max={1_000_000}
                  unit={w.unit}
                  onChange={(n) => put({ out_above: n })}
                />
                <NumberField
                  label='Scale in below'
                  value={m.in_below}
                  min={0}
                  max={1_000_000}
                  unit={w.unit}
                  onChange={(n) => put({ in_below: n })}
                />
                <button
                  type='button'
                  className={cn(ghostButton, 'ml-auto')}
                  aria-label={`Remove ${w.label}`}
                  onClick={() => set({ metrics: rule.metrics.filter((_, j) => j !== i) })}
                >
                  <X className='h-3.5 w-3.5' aria-hidden />
                </button>
                {bad && (
                  <p className='m-0 w-full text-[11px] text-red-600 dark:text-red-400'>
                    Scale in below a lower figure than you scale out above, so the two never fight.
                  </p>
                )}
              </li>
            )
          })}
        </ul>
        {unused.length > 0 && (
          <div className='mt-2 flex items-center gap-2'>
            <AddMetric
              options={unused}
              onAdd={(metric) =>
                set({ metrics: [...rule.metrics, { metric, ...METRIC_DEFAULTS[metric] }] })
              }
            />
          </div>
        )}
      </fieldset>

      <details className='group rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'>
        <summary className='cursor-pointer text-[12px] font-medium text-slate-700 dark:text-foreground'>
          Timing: how long a figure must hold, cooldowns
        </summary>
        <div className='mt-3 flex flex-wrap gap-x-6 gap-y-3'>
          <NumberField
            label='Out after'
            value={rule.sustain}
            min={1}
            max={30}
            unit='checks above (1 a minute)'
            onChange={(n) => set({ sustain: n })}
          />
          <NumberField
            label='In after'
            value={rule.sustain_in}
            min={1}
            max={120}
            unit='checks below'
            onChange={(n) => set({ sustain_in: n })}
          />
          <NumberField
            label='Wait after a change (out)'
            value={rule.cooldown_out_min}
            min={0}
            max={240}
            unit='min'
            onChange={(n) => set({ cooldown_out_min: n })}
          />
          <NumberField
            label='Wait after a change (in)'
            value={rule.cooldown_in_min}
            min={0}
            max={1440}
            unit='min'
            onChange={(n) => set({ cooldown_in_min: n })}
          />
          <NumberField
            label='At most one step every'
            value={rule.step_every_min}
            min={1}
            max={1440}
            unit='min'
            onChange={(n) => set({ step_every_min: n })}
          />
        </div>
      </details>

      <fieldset className='m-0 min-w-0 border-0 p-0'>
        <legend className='mb-2 text-[12px] font-medium text-slate-700 dark:text-foreground'>
          Schedules
        </legend>
        <p className='m-0 mb-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Inside a window the role keeps at least its floor; outside it the figures decide again.
        </p>
        <ul className='m-0 list-none space-y-2 p-0'>
          {rule.schedules.map((s, i) => (
            <ScheduleRow
              // biome-ignore lint/suspicious/noArrayIndexKey: windows are edited in place (a content key would remount the row on every keystroke)
              key={i}
              s={s}
              max={rule.max}
              onChange={(next) =>
                set({ schedules: rule.schedules.map((x, j) => (j === i ? next : x)) })
              }
              onRemove={() => set({ schedules: rule.schedules.filter((_, j) => j !== i) })}
            />
          ))}
        </ul>
        {rule.schedules.length < 7 && (
          <button
            type='button'
            className={cn(ghostButton, 'mt-2')}
            onClick={() =>
              set({
                schedules: [
                  ...rule.schedules,
                  {
                    days: [1, 2, 3, 4, 5],
                    from: '07:00',
                    to: '19:00',
                    zone: DEFAULT_ZONE,
                    min: Math.min(rule.max, Math.max(rule.min + 1, rule.min))
                  }
                ]
              })
            }
          >
            <Plus className='h-3.5 w-3.5' aria-hidden /> Add a window
          </button>
        )}
      </fieldset>

      <div className='flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3 dark:border-border'>
        <button
          type='button'
          className={cn(
            smallButton,
            'bg-nvr-cyan text-white hover:bg-nvr-cyan/90 disabled:opacity-50'
          )}
          disabled={saving || !!hysteresisBad || rule.max < rule.min}
          onClick={() => onSave(rule)}
        >
          {saving ? 'Saving…' : 'Save rule'}
        </button>
        <button type='button' className={ghostButton} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        {onClear && (
          <button
            type='button'
            className={cn(ghostButton, 'ml-auto')}
            onClick={onClear}
            disabled={saving}
          >
            Remove the rule
          </button>
        )}
      </div>
    </div>
  )
}

function starter(r: RoleView): AutoRule {
  const first: Metric = r.metrics[0] ?? 'cpu_pct'
  return {
    enabled: true,
    min: Math.max(r.min, Math.min(r.replicas, 10)),
    max: Math.min(10, Math.max(r.replicas + 2, r.min)),
    metrics: [{ metric: first, ...METRIC_DEFAULTS[first] }],
    sustain: 3,
    sustain_in: 10,
    cooldown_out_min: 5,
    cooldown_in_min: 15,
    step_every_min: 10,
    step: 1,
    schedules: []
  }
}

function AddMetric({ options, onAdd }: { options: Metric[]; onAdd: (m: Metric) => void }) {
  return (
    <SimpleSelect
      value=''
      onChange={(v) => v && onAdd(v as Metric)}
      ariaLabel='Add a figure'
      className='h-8 w-56 text-[12px]'
      options={[
        { value: '', label: 'Add a figure…' },
        ...options.map((m) => ({ value: m, label: METRIC_WORDS[m].label }))
      ]}
    />
  )
}

function ScheduleRow({
  s,
  max,
  onChange,
  onRemove
}: {
  s: ScaleSchedule
  max: number
  onChange: (s: ScaleSchedule) => void
  onRemove: () => void
}) {
  const id = useId()
  return (
    <li className='flex flex-wrap items-end gap-x-4 gap-y-2 rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'>
      <fieldset className='m-0 flex flex-wrap gap-1 border-0 p-0'>
        <legend className='sr-only'>Days</legend>
        {DAYS.map((d, i) => {
          const on = s.days.includes(i)
          return (
            <button
              key={d}
              type='button'
              aria-pressed={on}
              onClick={() =>
                onChange({
                  ...s,
                  days: on ? s.days.filter((x) => x !== i) : [...s.days, i].sort((a, b) => a - b)
                })
              }
              className={cn(
                'h-7 w-10 rounded-md border text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                on
                  ? 'border-nvr-cyan bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
                  : 'border-slate-200 text-slate-500 hover:bg-muted dark:border-border dark:text-muted-foreground'
              )}
            >
              {d}
            </button>
          )
        })}
      </fieldset>
      <div>
        <label
          htmlFor={`${id}-from`}
          className='block text-[11px] text-slate-500 dark:text-muted-foreground'
        >
          From
        </label>
        <Input
          id={`${id}-from`}
          type='time'
          className='mt-1 h-8 w-28 text-[13px] tabular-nums'
          value={s.from}
          onChange={(e) => onChange({ ...s, from: e.target.value })}
        />
      </div>
      <div>
        <label
          htmlFor={`${id}-to`}
          className='block text-[11px] text-slate-500 dark:text-muted-foreground'
        >
          To
        </label>
        <Input
          id={`${id}-to`}
          type='time'
          className='mt-1 h-8 w-28 text-[13px] tabular-nums'
          value={s.to}
          onChange={(e) => onChange({ ...s, to: e.target.value })}
        />
      </div>
      <div>
        <label
          htmlFor={`${id}-zone`}
          className='block text-[11px] text-slate-500 dark:text-muted-foreground'
        >
          Time zone
        </label>
        <Input
          id={`${id}-zone`}
          className='mt-1 h-8 w-44 text-[13px]'
          value={s.zone}
          spellCheck={false}
          onChange={(e) => onChange({ ...s, zone: e.target.value })}
        />
      </div>
      <NumberField
        label='Keep at least'
        value={s.min}
        min={1}
        max={max}
        unit='replicas'
        onChange={(n) => onChange({ ...s, min: n })}
      />
      <button
        type='button'
        className={cn(ghostButton, 'ml-auto')}
        aria-label='Remove this window'
        onClick={onRemove}
      >
        <X className='h-3.5 w-3.5' aria-hidden />
      </button>
    </li>
  )
}
