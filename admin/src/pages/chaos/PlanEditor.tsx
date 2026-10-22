import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Flag, Megaphone, Plus, X, Zap } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { UserCombobox } from '@/components/user-combobox'
import { api, type User } from '@/lib/api'
import { cn } from '@/lib/utils'
import { type Catalog, chaosKeys, errText, fetchCatalog } from './api'
import {
  easternToIso,
  fmtOffset,
  type GamedayInject,
  type GamedayPlan,
  type InjectKind,
  isoToEastern,
  parseOffset,
  planErrorsOf,
  saveGameday
} from './gameday-api'

/**
 * The game-day plan editor (#2852): what, when (Eastern time), who (lead, scribe, responders),
 * how (blind, automatic start, chat channel, monthly), and the timed list of injects — at
 * +mm:ss arm a fault, post an announcement, or reach a checkpoint. Inline in the detail pane,
 * never a modal. The server validates again and answers every error at once.
 */

const inputCls =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-900 placeholder:text-slate-500 focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
const labelCls = 'block text-[11.5px] font-medium text-slate-600 dark:text-muted-foreground'

const KIND_OPTIONS = [
  { value: 'fault', label: 'Arm a fault' },
  { value: 'announce', label: 'Announce' },
  { value: 'checkpoint', label: 'Checkpoint' }
]
const KIND_ICON: Record<InjectKind, typeof Zap> = {
  fault: Zap,
  announce: Megaphone,
  checkpoint: Flag
}

let seq = 0
const newId = () => `n${Date.now().toString(36).slice(-4)}${seq++}`

export function PlanEditor({
  initial,
  id,
  onDone
}: {
  initial: GamedayPlan
  /** Editing a planned day; absent = a new one. */
  id?: string | null
  onDone: (runId: string | null) => void
}) {
  const qc = useQueryClient()
  const [plan, setPlan] = useState<GamedayPlan>(initial)
  const start = isoToEastern(initial.starts_at)
  const [date, setDate] = useState(start.date)
  const [time, setTime] = useState(start.time)
  const [offsets, setOffsets] = useState<Record<string, string>>(() =>
    Object.fromEntries(initial.injects.map((i) => [i.id, fmtOffset(i.at_s)]))
  )
  const [errors, setErrors] = useState<string[]>([])
  const errorsRef = useRef<HTMLDivElement>(null)
  // A failed save brings its list into view and moves focus there, so the fixes are read first.
  useEffect(() => {
    if (!errors.length) return
    errorsRef.current?.scrollIntoView({ block: 'nearest' })
    errorsRef.current?.focus({ preventScroll: true })
  }, [errors])
  const set = <K extends keyof GamedayPlan>(k: K, v: GamedayPlan[K]) =>
    setPlan((p) => ({ ...p, [k]: v }))

  const { data: catalog } = useQuery<Catalog>({
    queryKey: chaosKeys.catalog,
    queryFn: fetchCatalog
  })
  const { data: users } = useQuery<User[]>({
    queryKey: ['users', 'combobox'],
    queryFn: () => api.get<{ data: User[] }>('/users?limit=200').then((r) => r.data.data)
  })
  const nameOf = (uid: string) => {
    const u = users?.find((x) => x.id.toLowerCase() === uid.toLowerCase())
    return u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email : 'Someone'
  }
  const faultOptions = useMemo(
    () => (catalog?.faults ?? []).map((f) => ({ value: f.key, label: f.label })),
    [catalog]
  )

  const patchInject = (iid: string, patch: Partial<GamedayInject>) =>
    set(
      'injects',
      plan.injects.map((i) => (i.id === iid ? { ...i, ...patch } : i))
    )
  const addInject = (kind: InjectKind) => {
    const last = plan.injects.reduce((m, i) => Math.max(m, i.at_s), -300)
    const at = Math.min(plan.duration_min * 60, last + 300)
    const inj: GamedayInject = {
      id: newId(),
      at_s: at,
      kind,
      label: '',
      ...(kind === 'fault'
        ? { fault: { fault_key: faultOptions[0]?.value ?? '', seconds: 60 } }
        : {}),
      ...(kind === 'announce' ? { text: '' } : {})
    }
    setOffsets((o) => ({ ...o, [inj.id]: fmtOffset(at) }))
    set('injects', [...plan.injects, inj])
  }

  const save = useMutation({
    mutationFn: () => {
      const starts = easternToIso(date, time)
      const bad: string[] = []
      if (!starts) bad.push('Pick a date and a time')
      const injects = plan.injects.map((i, n) => {
        const at = parseOffset(offsets[i.id] ?? '')
        if (at == null) bad.push(`Inject ${n + 1}: write the time as +mm:ss`)
        return { ...i, at_s: at ?? i.at_s }
      })
      if (bad.length) return Promise.reject({ local: bad })
      return saveGameday({ ...plan, starts_at: starts as string, injects }, id)
    },
    onSuccess: ({ run, warnings }) => {
      setErrors([])
      for (const w of warnings) toast.warning(w)
      toast.success(id ? 'Plan saved' : 'Game day planned — invitations sent')
      void qc.invalidateQueries({ queryKey: ['chaos'] })
      onDone(run.id)
    },
    onError: (e) => {
      const local = (e as { local?: string[] }).local
      const list = local ?? planErrorsOf(e)
      if (list) setErrors(list)
      else toast.error(errText(e, 'The plan was not saved'))
    }
  })

  const responders = plan.responders
  return (
    <form
      className='space-y-6 px-4 pt-6 sm:px-6'
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <h2 className='text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
            {id ? 'Edit game day' : 'Plan a game day'}
          </h2>
          <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            Everyone named gets an invitation now and reminders before it starts.
          </p>
        </div>
      </div>

      {errors.length > 0 && (
        <div
          ref={errorsRef}
          role='alert'
          tabIndex={-1}
          className='flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200'
        >
          <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
          <div className='min-w-0'>
            <p className='font-medium'>
              The plan needs {errors.length === 1 ? 'one fix' : `${errors.length} fixes`}
            </p>
            <ul className='mt-1 list-disc space-y-0.5 pl-4'>
              {errors.map((er) => (
                <li key={er}>{er}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <section className='grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]'>
        <label className='space-y-1'>
          <span className={labelCls}>Title</span>
          <input
            className={inputCls}
            value={plan.title}
            maxLength={120}
            onChange={(e) => set('title', e.target.value)}
            placeholder='e.g. November staging game day'
          />
        </label>
        <label className='space-y-1'>
          <span className={labelCls}>Date</span>
          <input
            type='date'
            className={cn(inputCls, 'tabular-nums dark:[color-scheme:dark]')}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className='space-y-1'>
          <span className={labelCls}>Start (Eastern time)</span>
          <input
            type='time'
            className={cn(inputCls, 'tabular-nums dark:[color-scheme:dark]')}
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </label>
        <label className='space-y-1'>
          <span className={labelCls}>Length (minutes)</span>
          <input
            type='number'
            min={15}
            max={480}
            className={cn(inputCls, 'tabular-nums')}
            value={plan.duration_min}
            onChange={(e) => set('duration_min', Number(e.target.value) || 0)}
          />
        </label>
      </section>

      <section className='space-y-3'>
        <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>People</h3>
        <div className='grid gap-4 md:grid-cols-3'>
          <div className='space-y-1'>
            <span className={labelCls}>Lead</span>
            <UserCombobox
              value={plan.lead || null}
              onChange={(v) => set('lead', v ?? '')}
              placeholder='Who runs the day'
              noneLabel='Nobody yet'
            />
            <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              Faults are armed as the lead; in blind mode only the lead sees the banner.
            </p>
          </div>
          <div className='space-y-1'>
            <span className={labelCls}>Scribe</span>
            <UserCombobox
              value={plan.scribe}
              onChange={(v) => set('scribe', v)}
              placeholder='Who keeps the notes'
              noneLabel='No scribe'
            />
          </div>
          <div className='space-y-1'>
            <span className={labelCls}>Responders</span>
            <UserCombobox
              value={null}
              onChange={(v) => {
                if (v && !responders.includes(v) && v !== plan.lead)
                  set('responders', [...responders, v])
              }}
              placeholder='Add a responder'
              noneLabel='—'
            />
            {responders.length > 0 ? (
              <ul className='flex flex-wrap gap-1.5 pt-1'>
                {responders.map((r) => (
                  <li
                    key={r}
                    className='inline-flex items-center gap-1 rounded bg-slate-100 py-0.5 pr-0.5 pl-2 text-[12px] text-slate-700 dark:bg-muted dark:text-foreground'
                  >
                    {nameOf(r)}
                    <button
                      type='button'
                      aria-label={`Remove ${nameOf(r)}`}
                      onClick={() =>
                        set(
                          'responders',
                          responders.filter((x) => x !== r)
                        )
                      }
                      className='rounded p-0.5 text-slate-500 hover:bg-slate-200 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-slate-700 dark:hover:text-foreground'
                    >
                      <X className='h-3 w-3' />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className='pt-1 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                The people who will notice and fix things.
              </p>
            )}
          </div>
        </div>
      </section>

      <section className='space-y-3'>
        <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          How it runs
        </h3>
        <div className='grid gap-x-6 gap-y-3 md:grid-cols-2'>
          <Toggle
            checked={plan.blind}
            onChange={(v) => set('blind', v)}
            label='Blind'
            hint='Responders get no drill banner and no drill tag on alerts until the lead reveals. Declare incident times their detection.'
          />
          <Toggle
            checked={plan.auto_start}
            onChange={(v) => set('auto_start', v)}
            label='Start automatically'
            hint='The scheduler starts the day at its time, after pre-flight. Off: the lead presses Start.'
          />
          <Toggle
            checked={plan.channel}
            onChange={(v) => set('channel', v)}
            label='Chat channel'
            hint='A private channel for the participants; a timeline bot posts each inject and checkpoint.'
          />
          <Toggle
            checked={plan.repeat === 'monthly'}
            onChange={(v) => set('repeat', v ? 'monthly' : 'none')}
            label='Repeat monthly'
            hint='When the day ends, the same weekday slot next month is planned with the same people.'
          />
        </div>
        <label className='block space-y-1'>
          <span className={labelCls}>Notes for the team</span>
          <textarea
            value={plan.notes}
            maxLength={2000}
            onChange={(e) => set('notes', e.target.value)}
            rows={2}
            className={cn(inputCls, 'h-auto min-h-[56px] py-1.5 leading-relaxed')}
            placeholder='What we want to learn, where to watch, who to call.'
          />
        </label>
      </section>

      <section className='space-y-3'>
        <div className='flex flex-wrap items-baseline justify-between gap-2'>
          <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>Injects</h3>
          <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            Times are after the start. Each fault runs through pre-flight when it fires.
          </span>
        </div>
        {plan.injects.length === 0 ? (
          <p className='rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-[12.5px] text-slate-500 dark:border-border dark:text-muted-foreground'>
            No injects yet. Add a fault to arm, an announcement for the channel, or a checkpoint to
            stop and look.
          </p>
        ) : (
          <ol className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border/60 dark:border-border dark:bg-card'>
            {plan.injects.map((inj, n) => {
              const Icon = KIND_ICON[inj.kind]
              const def = catalog?.faults.find((f) => f.key === inj.fault?.fault_key)
              return (
                <li key={inj.id} className='flex flex-wrap items-center gap-2 px-3 py-2'>
                  <span className='w-5 text-right text-[11px] tabular-nums text-slate-400 dark:text-muted-foreground'>
                    {n + 1}
                  </span>
                  <label className='relative flex items-center'>
                    <span className='sr-only'>Time after the start, as minutes:seconds</span>
                    <span
                      className='pointer-events-none absolute left-2 font-mono text-[12px] text-slate-400 dark:text-muted-foreground'
                      aria-hidden
                    >
                      +
                    </span>
                    <input
                      value={offsets[inj.id] ?? ''}
                      onChange={(e) => setOffsets((o) => ({ ...o, [inj.id]: e.target.value }))}
                      inputMode='numeric'
                      className={cn(inputCls, 'w-[72px] pl-5 font-mono text-[12px] tabular-nums')}
                      placeholder='mm:ss'
                    />
                  </label>
                  <Icon
                    className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-muted-foreground'
                    aria-hidden
                  />
                  <SimpleSelect
                    value={inj.kind}
                    onChange={(v) => {
                      const kind = v as InjectKind
                      patchInject(inj.id, {
                        kind,
                        fault:
                          kind === 'fault'
                            ? (inj.fault ?? {
                                fault_key: faultOptions[0]?.value ?? '',
                                seconds: 60
                              })
                            : undefined,
                        text: kind === 'announce' ? (inj.text ?? '') : undefined
                      })
                    }}
                    options={KIND_OPTIONS}
                    ariaLabel='Inject kind'
                    className='h-8 w-[132px] text-[12.5px]'
                  />
                  {inj.kind === 'fault' && (
                    <>
                      <SimpleSelect
                        value={inj.fault?.fault_key ?? ''}
                        onChange={(v) =>
                          patchInject(inj.id, {
                            fault: { ...(inj.fault ?? { fault_key: v }), fault_key: v, params: {} }
                          })
                        }
                        options={
                          inj.fault?.fault_key &&
                          !faultOptions.some((o) => o.value === inj.fault?.fault_key)
                            ? [
                                ...faultOptions,
                                {
                                  value: inj.fault.fault_key,
                                  label: `${inj.fault.fault_key} (not on this instance)`
                                }
                              ]
                            : faultOptions
                        }
                        ariaLabel='Fault'
                        className='h-8 w-[200px] text-[12.5px]'
                      />
                      <label className='flex items-center gap-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
                        for
                        <input
                          type='number'
                          min={5}
                          max={def?.max_seconds ?? 3600}
                          value={inj.fault?.seconds ?? def?.default_seconds ?? 60}
                          onChange={(e) =>
                            patchInject(inj.id, {
                              fault: {
                                ...(inj.fault ?? { fault_key: '' }),
                                seconds: Number(e.target.value) || undefined
                              }
                            })
                          }
                          className={cn(inputCls, 'w-[72px] tabular-nums')}
                          aria-label='Seconds'
                        />
                        s
                      </label>
                    </>
                  )}
                  {inj.kind === 'announce' ? (
                    <input
                      value={inj.text ?? ''}
                      maxLength={500}
                      onChange={(e) => patchInject(inj.id, { text: e.target.value })}
                      placeholder='Posted to the channel as the lead'
                      aria-label='Announcement'
                      className={cn(inputCls, 'min-w-[200px] flex-1')}
                    />
                  ) : (
                    <input
                      value={inj.label}
                      maxLength={120}
                      onChange={(e) => patchInject(inj.id, { label: e.target.value })}
                      placeholder={inj.kind === 'checkpoint' ? 'What to check' : 'Label (optional)'}
                      aria-label='Label'
                      className={cn(inputCls, 'min-w-[160px] flex-1')}
                    />
                  )}
                  <button
                    type='button'
                    aria-label={`Remove inject ${n + 1}`}
                    onClick={() =>
                      set(
                        'injects',
                        plan.injects.filter((i) => i.id !== inj.id)
                      )
                    }
                    className='rounded p-1 text-slate-400 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted dark:hover:text-foreground'
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                </li>
              )
            })}
          </ol>
        )}
        <div className='flex flex-wrap gap-2'>
          {(['fault', 'announce', 'checkpoint'] as InjectKind[]).map((k) => {
            const Icon = KIND_ICON[k]
            return (
              <button
                key={k}
                type='button'
                onClick={() => addInject(k)}
                className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
              >
                <Plus className='h-3.5 w-3.5' aria-hidden />
                <Icon className='h-3.5 w-3.5 text-slate-400' aria-hidden />
                {KIND_OPTIONS.find((o) => o.value === k)?.label}
              </button>
            )
          })}
        </div>
      </section>

      <div className='sticky bottom-0 z-10 -mx-4 flex items-center gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 sm:-mx-6 sm:px-6 dark:border-border dark:bg-background'>
        <button
          type='submit'
          disabled={save.isPending}
          className='h-8 rounded-md bg-nvr-cyan px-3.5 text-[12.5px] font-medium text-white transition-colors duration-150 hover:bg-[#00b8e0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 disabled:opacity-40 dark:focus-visible:ring-offset-background'
        >
          {save.isPending ? 'Saving…' : id ? 'Save plan' : 'Plan the day'}
        </button>
        <button
          type='button'
          onClick={() => onDone(id ?? null)}
          className='h-8 rounded-md px-3 text-[12.5px] text-slate-600 transition-colors duration-150 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-muted'
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
}) {
  const id = useId()
  return (
    <div className='flex items-start gap-3'>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className='mt-0.5 h-5 w-9 data-[state=checked]:bg-nvr-cyan [&>span]:h-4 [&>span]:w-4 [&>span]:data-[state=checked]:translate-x-4'
      />
      <span>
        <label
          htmlFor={id}
          className='block text-[12.5px] font-medium text-slate-900 dark:text-foreground'
        >
          {label}
        </label>
        <span className='block max-w-[60ch] text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
          {hint}
        </span>
      </span>
    </div>
  )
}
