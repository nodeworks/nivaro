import { ConfirmButton } from '@nivaro/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Clock, Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { MonCombobox } from '@/components/filter-combobox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { cn, formatDateTime } from '@/lib/utils'
import { hubToast } from '../hub-api'
import { dangerArmed, dangerGhost, Field, ghostButton, SectionCard } from '../hub-parts'
import { isoToLocalInput, localInputToIso, viewerTimeZone } from '../releases/releases-api'
import {
  type ChangesOverview,
  changeKeys,
  DAY_LETTERS,
  type DeployWindow,
  deleteWindow,
  saveWindow,
  type WeeklyRange
} from './changes-api'

/**
 * Deploy windows: the times an app may be promoted. Judged by the same engine as freeze windows
 * (a freeze wins), on promotions and Apply now; a rollback to an older version always goes
 * through. Owners read; administrators change them.
 */

const appKeyOf = (d: ChangesOverview, id: number | null) =>
  id == null ? 'Every app without its own' : (d.apps.find((a) => a.id === id)?.key ?? `#${id}`)

function timeZones(current: string): string[] {
  let all: string[] = []
  try {
    all =
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
        'timeZone'
      ) ?? []
  } catch {
    all = []
  }
  return [...new Set(['UTC', 'America/New_York', current, ...all])]
}

function ZonePicker({
  id,
  value,
  onChange
}: {
  id: string
  value: string
  onChange: (v: string) => void
}) {
  const options = useMemo(() => timeZones(value).map((z) => ({ value: z, label: z })), [value])
  return (
    <div id={id}>
      <MonCombobox
        value={value}
        onChange={(v) => {
          const hit = options.find((o) => o.value.toLowerCase() === v.toLowerCase())
          if (hit) onChange(hit.value)
        }}
        options={options}
        placeholder='Pick a time zone'
        className='w-full bg-white text-[13px] dark:bg-background'
      />
    </div>
  )
}

function RangeRow({
  r,
  idPrefix,
  onChange,
  onRemove
}: {
  r: WeeklyRange
  idPrefix: string
  onChange: (r: WeeklyRange) => void
  onRemove?: () => void
}) {
  const toggle = (d: number) =>
    onChange({
      ...r,
      days: r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d].sort()
    })
  return (
    <div className='flex flex-wrap items-center gap-2'>
      <fieldset className='m-0 flex border-0 p-0'>
        <legend className='sr-only'>Days</legend>
        {DAY_LETTERS.map((w, i) => {
          const on = r.days.includes(i + 1)
          return (
            <button
              key={w}
              type='button'
              aria-pressed={on}
              onClick={() => toggle(i + 1)}
              className={cn(
                'h-8 w-10 border border-l-0 text-[11.5px] font-medium first:rounded-l-md first:border-l last:rounded-r-md focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                on
                  ? 'border-nvr-cyan/60 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                  : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-border dark:bg-background dark:text-slate-400 dark:hover:bg-muted'
              )}
            >
              {w}
            </button>
          )
        })}
      </fieldset>
      <label className='sr-only' htmlFor={`${idPrefix}-from`}>
        From
      </label>
      <Input
        id={`${idPrefix}-from`}
        type='time'
        value={r.from}
        onChange={(e) => onChange({ ...r, from: e.target.value })}
        className='h-8 w-[110px] text-[13px]'
      />
      <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>to</span>
      <label className='sr-only' htmlFor={`${idPrefix}-to`}>
        To
      </label>
      <Input
        id={`${idPrefix}-to`}
        type='time'
        value={r.to === '24:00' ? '00:00' : r.to}
        onChange={(e) =>
          onChange({ ...r, to: e.target.value === '00:00' ? '24:00' : e.target.value })
        }
        className='h-8 w-[110px] text-[13px]'
      />
      {onRemove && (
        <button
          type='button'
          className={ghostButton}
          aria-label='Remove this range'
          onClick={onRemove}
        >
          <X className='h-3.5 w-3.5' aria-hidden />
        </button>
      )}
    </div>
  )
}

function WindowForm({
  data,
  current,
  onDone
}: {
  data: ChangesOverview
  current: DeployWindow | null
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(current?.name ?? '')
  const [appId, setAppId] = useState(current?.app_id ? String(current.app_id) : '')
  const [scope, setScope] = useState<'production' | 'all'>(current?.env_scope ?? 'production')
  const [recurrence, setRecurrence] = useState<'weekly' | 'none'>(current?.recurrence ?? 'weekly')
  const [ranges, setRanges] = useState<WeeklyRange[]>(
    current?.ranges?.length
      ? current.ranges
      : [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '17:00' }]
  )
  const [tz, setTz] = useState(current?.time_zone ?? viewerTimeZone())
  const [start, setStart] = useState(isoToLocalInput(current?.starts_at))
  const [end, setEnd] = useState(isoToLocalInput(current?.ends_at))
  const [enabled, setEnabled] = useState(current?.enabled ?? true)
  const save = useMutation({
    mutationFn: () =>
      saveWindow(current?.id ?? null, {
        name,
        app_id: appId ? Number(appId) : null,
        env_scope: scope,
        recurrence,
        enabled,
        ...(recurrence === 'weekly'
          ? { ranges, time_zone: tz }
          : { starts_at: localInputToIso(start), ends_at: localInputToIso(end) })
      }),
    onSuccess: () => {
      toast.success('Deploy window saved')
      void qc.invalidateQueries({ queryKey: changeKeys.all })
      onDone()
    },
    onError: (err) => hubToast(err, 'Could not save the deploy window')
  })
  const rangesOk = ranges.every((r) => r.days.length > 0 && r.from && r.to && r.from !== r.to)
  return (
    <div className='space-y-3 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-border dark:bg-muted/40'>
      <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
        <Field id='dw-name' label='Name'>
          <Input
            id='dw-name'
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='Office hours'
            className='h-8 text-[13px]'
          />
        </Field>
        <Field
          id='dw-app'
          label='Applies to'
          hint='An app’s own windows replace the Hub-wide ones.'
        >
          <SimpleSelect
            value={appId || 'all'}
            onChange={(v) => setAppId(v === 'all' ? '' : v)}
            options={[
              { value: 'all', label: 'Every app without its own' },
              ...data.apps.map((a) => ({ value: String(a.id), label: a.key }))
            ]}
            ariaLabel='Applies to'
            className='h-8 bg-white text-left text-[13px] dark:bg-background'
            triggerProps={{ id: 'dw-app' }}
          />
        </Field>
        <Field id='dw-scope' label='Environments'>
          <SimpleSelect
            value={scope}
            onChange={(v) => setScope(v === 'all' ? 'all' : 'production')}
            options={[
              { value: 'production', label: 'Production only' },
              { value: 'all', label: 'Every environment' }
            ]}
            ariaLabel='Environments'
            className='h-8 bg-white text-left text-[13px] dark:bg-background'
            triggerProps={{ id: 'dw-scope' }}
          />
        </Field>
        <Field id='dw-repeat' label='Repeats'>
          <SimpleSelect
            value={recurrence}
            onChange={(v) => setRecurrence(v === 'none' ? 'none' : 'weekly')}
            options={[
              { value: 'weekly', label: 'Every week' },
              { value: 'none', label: 'Once (an extra window)' }
            ]}
            ariaLabel='Repeats'
            className='h-8 bg-white text-left text-[13px] dark:bg-background'
            triggerProps={{ id: 'dw-repeat' }}
          />
        </Field>
      </div>
      {recurrence === 'weekly' ? (
        <div className='space-y-2'>
          <div className='grid gap-3 sm:grid-cols-[1fr_280px]'>
            <div className='space-y-2'>
              <span className='block text-[12px] font-medium text-slate-700 dark:text-foreground'>
                Open
              </span>
              {ranges.map((r, i) => (
                <RangeRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: ranges have no id of their own
                  key={i}
                  r={r}
                  idPrefix={`dw-range-${i}`}
                  onChange={(next) => setRanges(ranges.map((x, j) => (j === i ? next : x)))}
                  onRemove={
                    ranges.length > 1
                      ? () => setRanges(ranges.filter((_, j) => j !== i))
                      : undefined
                  }
                />
              ))}
              <button
                type='button'
                className={ghostButton}
                onClick={() => setRanges([...ranges, { days: [6], from: '09:00', to: '12:00' }])}
              >
                <Plus className='h-3.5 w-3.5' aria-hidden /> Add a range
              </button>
            </div>
            <Field
              id='dw-zone'
              label='Time zone'
              hint='The times are read on this zone’s clock, daylight saving included. A range ending at or before it starts runs past midnight.'
            >
              <ZonePicker id='dw-zone' value={tz} onChange={setTz} />
            </Field>
          </div>
        </div>
      ) : (
        <div className='grid gap-3 sm:grid-cols-2'>
          <Field id='dw-start' label='From' hint={`Your time (${viewerTimeZone()}).`}>
            <Input
              id='dw-start'
              type='datetime-local'
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className='h-8 text-[13px]'
            />
          </Field>
          <Field id='dw-end' label='Until' hint='At most 31 days.'>
            <Input
              id='dw-end'
              type='datetime-local'
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className='h-8 text-[13px]'
            />
          </Field>
        </div>
      )}
      <div className='flex items-center gap-2'>
        <Switch id='dw-enabled' checked={enabled} onCheckedChange={setEnabled} />
        <label htmlFor='dw-enabled' className='text-[12px] text-slate-700 dark:text-foreground'>
          {enabled ? 'On' : 'Off (kept, not judged)'}
        </label>
      </div>
      <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
        Outside every window that applies, the Hub refuses promotions and Apply now; a scheduled
        promotion or a release train waits for the next opening. A rollback to an older version than
        the one running is always allowed — a “rollback” to the same or a newer version counts as a
        promotion.
      </p>
      <div className='flex gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!name.trim() || (recurrence === 'weekly' && !rangesOk) || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save window'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export function DeployWindowsCard({ data, isAdmin }: { data: ChangesOverview; isAdmin: boolean }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<DeployWindow | 'new' | null>(null)
  const remove = useMutation({
    mutationFn: (id: number) => deleteWindow(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: changeKeys.all }),
    onError: (err) => hubToast(err, 'Could not delete the deploy window')
  })
  // Production environments a window governs, with whether it is open now.
  const governed = data.environments.filter((e) => e.window.governed && !e.on_shared)
  return (
    <SectionCard
      title='Deploy windows'
      description='When an app may be promoted. Freezes still win; a rollback to an older version always goes through.'
      actions={
        isAdmin &&
        !editing && (
          <button type='button' className={ghostButton} onClick={() => setEditing('new')}>
            <Clock className='h-3.5 w-3.5' aria-hidden /> New window
          </button>
        )
      }
    >
      {editing && (
        <WindowForm
          key={editing === 'new' ? 'new' : editing.id}
          data={data}
          current={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}
      {governed.length > 0 && (
        <ul
          aria-label='Right now'
          className='m-0 flex list-none flex-wrap gap-1.5 border-b border-slate-100 px-4 py-2.5 dark:border-border'
        >
          {governed.map((e) => {
            const app = data.apps.find((a) => a.id === e.app_id)?.key ?? ''
            return (
              <li
                key={e.id}
                className={cn(
                  'rounded-full border px-2 py-px text-[11px] font-medium',
                  e.window.open
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200'
                    : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted/40 dark:text-slate-300'
                )}
              >
                {app} · {e.key}:{' '}
                {e.window.open
                  ? `open until ${e.window.closes_at ? formatDateTime(e.window.closes_at) : '—'}`
                  : e.window.opens_at
                    ? `opens ${formatDateTime(e.window.opens_at)}`
                    : 'closed'}
              </li>
            )
          })}
        </ul>
      )}
      {data.windows.length === 0 ? (
        <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No deploy windows: every app may be promoted at any time outside a freeze.
        </p>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {data.windows.map((w) => (
            <li key={w.id} className='flex items-center gap-3 px-4 py-2.5 text-[12px]'>
              <div className='min-w-0 flex-1 space-y-0.5'>
                <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
                  <span className='font-medium text-slate-900 dark:text-foreground'>{w.name}</span>
                  <span className='text-slate-500 dark:text-muted-foreground'>
                    {appKeyOf(data, w.app_id)} ·{' '}
                    {w.env_scope === 'production' ? 'production' : 'every environment'}
                  </span>
                  {!w.enabled && (
                    <span className='rounded-full border border-slate-200 px-2 py-px text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                      Off
                    </span>
                  )}
                </div>
                <div className='text-[11px] text-slate-600 dark:text-slate-300'>
                  {w.recurrence === 'none'
                    ? `${w.starts_at ? formatDateTime(w.starts_at) : '?'} → ${w.ends_at ? formatDateTime(w.ends_at) : '?'}`
                    : w.words}
                </div>
              </div>
              {isAdmin && (
                <div className='flex shrink-0 gap-1'>
                  <button type='button' className={ghostButton} onClick={() => setEditing(w)}>
                    Edit
                  </button>
                  <ConfirmButton
                    className={dangerGhost}
                    armedClassName={dangerArmed}
                    confirmLabel='Delete it?'
                    onConfirm={() => remove.mutate(w.id)}
                  >
                    Delete
                  </ConfirmButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}
