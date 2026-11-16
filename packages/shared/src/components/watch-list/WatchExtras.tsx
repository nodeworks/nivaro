import { useQuery } from '@tanstack/react-query'
import {
  Bell,
  BellRing,
  Check,
  Clock,
  GitBranch,
  ListChecks,
  Plus,
  Search,
  Settings2,
  Users,
  X
} from 'lucide-react'
import { type ReactNode, useId, useMemo, useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { describeError } from '../../lib/error-message'
import {
  type DesktopPermission,
  desktopPermission,
  requestDesktopPermission
} from '../../lib/watch-desktop'
import {
  type useWatchActions,
  type WatchAlertKind,
  type WatchAlertOptions,
  type WatchAlertRef,
  type WatchRowData,
  type WatchTeam,
  watchKeys
} from '../../lib/watch-list'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Skeleton } from '../ui/skeleton'

/**
 * Watch list round 2 (rt6): the dock's settings menu (desktop alerts, auto-add / auto-remove,
 * the daily email, shared lists), the per-row alert rules popover, and the shared-list editor.
 * Everything is the person's own: writes go through useWatchActions (cache first, server next).
 */

type Actions = ReturnType<typeof useWatchActions>
type Client = NonNullable<ReturnType<typeof useOptionalNivaroClient>>

// ── Small parts ─────────────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
  indent
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: ReactNode
  disabled?: boolean
  indent?: boolean
}) {
  const id = useId()
  return (
    <div className={`flex items-start gap-3 py-2 ${indent ? 'pl-4' : ''}`}>
      <div className='min-w-0 flex-1'>
        <label
          htmlFor={id}
          className={`block text-balance text-[12.5px] font-medium ${
            disabled ? 'text-slate-400 dark:text-slate-500' : 'text-slate-800 dark:text-slate-100'
          }`}
        >
          {label}
        </label>
        {hint && (
          <div className='mt-0.5 text-[11.5px] leading-snug text-slate-500 dark:text-slate-400'>
            {hint}
          </div>
        )}
      </div>
      <button
        id={id}
        type='button'
        role='switch'
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 focus-visible:ring-offset-1 focus-visible:ring-offset-popover disabled:cursor-not-allowed disabled:opacity-40 ${
          checked ? 'bg-nvr-cyan' : 'bg-slate-300 dark:bg-white/[0.16]'
        }`}
      >
        <span
          aria-hidden
          className={`inline-block h-3.5 w-3.5 rounded-full bg-[#fff] shadow-[0_1px_2px_rgba(15,23,42,0.25)] transition-transform motion-reduce:transition-none ${
            checked ? 'translate-x-[16px]' : 'translate-x-[2px]'
          }`}
        />
      </button>
    </div>
  )
}

function MenuHeading({ children }: { children: ReactNode }) {
  return (
    <p className='px-3 pb-1 pt-3 text-[11px] font-semibold text-slate-500 dark:text-slate-400'>
      {children}
    </p>
  )
}

const iconBtn =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-500 dark:hover:bg-white/[0.06] dark:hover:text-slate-200'

// ── Settings menu ───────────────────────────────────────────────────────────────

export function WatchSettingsMenu({
  actions,
  onOpenTeam,
  onNewTeam
}: {
  actions: Actions
  onOpenTeam: (id: string) => void
  onNewTeam: () => void
}) {
  const { settings, teams } = actions.prefs
  const [perm, setPerm] = useState<DesktopPermission>(() => desktopPermission())
  const [open, setOpen] = useState(false)
  const toggleDesktop = async (on: boolean) => {
    if (!on) return void actions.setSettings({ desktop: false }).catch(() => {})
    // The browser asks only from here, never on load.
    const p = perm === 'granted' ? perm : await requestDesktopPermission()
    setPerm(p)
    if (p === 'granted') await actions.setSettings({ desktop: true }).catch(() => {})
  }
  const desktopHint =
    perm === 'unsupported' ? (
      'This browser cannot show notifications.'
    ) : perm === 'denied' ? (
      <span className='text-amber-700 dark:text-amber-300'>
        Your browser blocks notifications for this site. Allow them in the browser’s site settings,
        then turn this on.
      </span>
    ) : (
      'A notice on your computer when someone else changes a pinned record while this page is in the background.'
    )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='Watch list settings'
          data-tip='Settings'
          className={iconBtn}
          data-watch-settings
        >
          <Settings2 className='h-3.5 w-3.5' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-[300px] p-0'
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className='px-3 pt-1'>
          <MenuHeading>Tell me</MenuHeading>
          <div className='divide-y divide-slate-100 px-3 dark:divide-white/[0.06]'>
            <Toggle
              label='Desktop alerts'
              hint={desktopHint}
              checked={settings.desktop && perm === 'granted'}
              disabled={perm === 'unsupported'}
              onChange={(v) => void toggleDesktop(v)}
            />
            <Toggle
              label='Daily email'
              hint='One email each morning of what changed on your pinned records. Nothing on quiet days.'
              checked={settings.digest}
              onChange={(v) => void actions.setSettings({ digest: v }).catch(() => {})}
            />
          </div>
          <MenuHeading>Pin for me</MenuHeading>
          <div className='px-3'>
            <Toggle
              label='Records that land on my step'
              hint='When a record moves to a step you own, it is pinned here for you.'
              checked={settings.auto_add}
              onChange={(v) => void actions.setSettings({ auto_add: v }).catch(() => {})}
            />
            <Toggle
              indent
              label='Unpin them when they leave my step'
              hint='Only records pinned this way. A record you pinned yourself stays.'
              checked={settings.auto_remove}
              disabled={!settings.auto_add}
              onChange={(v) => void actions.setSettings({ auto_remove: v }).catch(() => {})}
            />
          </div>
          <MenuHeading>Tidy up</MenuHeading>
          <div className='px-3'>
            <Toggle
              label='Remove records when they’re completed'
              hint='They show “Completed”, then leave 24 hours later or once you’ve seen them. Recently removed keeps them 7 days, with Undo.'
              checked={settings.remove_completed}
              onChange={(v) => void actions.setSettings({ remove_completed: v }).catch(() => {})}
            />
          </div>
        </div>
        <div className='mt-1 border-t border-border px-3 pb-2'>
          <MenuHeading>Shared lists</MenuHeading>
          {teams.length === 0 ? (
            <p className='px-3 pb-1 text-[11.5px] leading-snug text-slate-500 dark:text-slate-400'>
              A list your team watches together. Each person sees only the records they can open.
            </p>
          ) : (
            <ul className='pb-1'>
              {teams.map((t) => (
                <li key={t.id}>
                  <button
                    type='button'
                    onClick={() => {
                      setOpen(false)
                      onOpenTeam(t.id)
                    }}
                    className='flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-slate-200'
                  >
                    <Users className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                    <span className='min-w-0 flex-1 truncate'>{t.name}</span>
                    <span className='shrink-0 text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
                      {t.pins.length}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type='button'
            onClick={() => {
              setOpen(false)
              onNewTeam()
            }}
            className='flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[12.5px] font-medium text-slate-700 hover:bg-muted dark:text-slate-200'
          >
            <Plus className='h-3.5 w-3.5 shrink-0' />
            New shared list
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ── Alert rules on one pinned record ───────────────────────────────────────────

const KIND_LABEL: Record<WatchAlertKind, string> = {
  step: 'It reaches a step',
  field: 'A field changes',
  overdue: 'It’s overdue'
}

export function alertWords(a: WatchAlertRef): string {
  const what =
    a.kind === 'step'
      ? `Reaches ${a.label ?? a.step ?? 'a step'}`
      : a.kind === 'field'
        ? `${a.label ?? a.field ?? 'A field'} changes`
        : 'It’s overdue'
  return `${what} · ${a.repeat ? 'every time' : 'once'}`
}

function PickList({
  items,
  value,
  onPick,
  placeholder,
  empty
}: {
  items: Array<{ value: string; label: string; color?: string | null }>
  value: string
  onPick: (v: string, label: string) => void
  placeholder: string
  empty: string
}) {
  const [q, setQ] = useState('')
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? items.filter((i) => i.label.toLowerCase().includes(s)) : items
  }, [items, q])
  return (
    <div className='rounded-md border border-border'>
      {items.length > 7 && (
        <div className='flex items-center gap-1.5 border-b border-border px-2'>
          <Search aria-hidden className='h-3 w-3 shrink-0 text-slate-400' />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className='h-7 min-w-0 flex-1 bg-transparent text-[12px] text-slate-800 outline-none placeholder:text-slate-400 dark:text-slate-100'
          />
        </div>
      )}
      <div role='listbox' aria-label={placeholder} className='max-h-36 overflow-y-auto p-1'>
        {shown.length === 0 && (
          <p className='px-2 py-1.5 text-[11.5px] text-slate-500 dark:text-slate-400'>{empty}</p>
        )}
        {shown.map((i) => {
          const on = i.value === value
          return (
            <button
              key={i.value}
              type='button'
              role='option'
              aria-selected={on}
              onClick={() => onPick(i.value, i.label)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] ${
                on
                  ? 'bg-accent text-slate-900 dark:text-slate-50'
                  : 'text-slate-700 hover:bg-muted dark:text-slate-200'
              }`}
            >
              {i.color !== undefined && (
                <span
                  aria-hidden
                  className='h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400'
                  style={i.color ? { backgroundColor: i.color } : undefined}
                />
              )}
              <span className='min-w-0 flex-1 truncate'>{i.label}</span>
              {on && <Check aria-hidden className='h-3 w-3 shrink-0 text-nvr-cyan' />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div
      role='radiogroup'
      aria-label={label}
      className='inline-flex rounded-md bg-slate-100 p-0.5 dark:bg-white/[0.06]'
    >
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as one row
        <button
          key={o.value}
          type='button'
          role='radio'
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 ${
            o.value === value
              ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)] dark:bg-white/[0.12] dark:text-slate-50'
              : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function AlertForm({
  row,
  actions,
  onDone
}: {
  row: WatchRowData
  actions: Actions
  onDone: () => void
}) {
  const client = useOptionalNivaroClient()
  const opts = useQuery({
    queryKey: watchKeys.alertOptions(row.collection, row.id),
    queryFn: () =>
      (client as Client)
        .request<{ data: WatchAlertOptions }>(
          get(
            `/watch-list/alert-options/${encodeURIComponent(row.collection)}/${encodeURIComponent(row.id)}`
          )
        )
        .then((r) => r.data),
    enabled: !!client,
    staleTime: 5 * 60_000
  })
  const [kind, setKind] = useState<WatchAlertKind>('step')
  const [target, setTarget] = useState<{ value: string; label: string } | null>(null)
  const [repeat, setRepeat] = useState<'once' | 'always'>('once')
  const [busy, setBusy] = useState(false)
  const ready = kind === 'overdue' || !!target
  const save = async () => {
    if (!ready || busy) return
    setBusy(true)
    try {
      await actions.addAlert({
        collection: row.collection,
        id: row.id,
        kind,
        ...(kind === 'step' ? { step: target?.value, label: target?.label } : {}),
        ...(kind === 'field' ? { field: target?.value, label: target?.label } : {}),
        repeat: repeat === 'always'
      })
      onDone()
    } catch {
      /* toasted */
    } finally {
      setBusy(false)
    }
  }
  if (opts.isError) {
    const d = describeError(opts.error, 'The choices could not load')
    return <p className='py-2 text-[12px] text-slate-600 dark:text-slate-300'>{d.title}</p>
  }
  const steps = opts.data?.steps ?? []
  const fields = opts.data?.fields ?? []
  const kinds: WatchAlertKind[] = ['step', 'field', 'overdue']
  return (
    <div className='space-y-2.5'>
      <div role='radiogroup' aria-label='Tell me when' className='space-y-0.5'>
        {kinds.map((k) => {
          const disabled = k === 'step' && opts.isSuccess && steps.length === 0
          const Icon = k === 'step' ? GitBranch : k === 'field' ? ListChecks : Clock
          return (
            // biome-ignore lint/a11y/useSemanticElements: a choice list, styled as menu rows
            <button
              key={k}
              type='button'
              role='radio'
              aria-checked={kind === k}
              disabled={disabled}
              onClick={() => {
                setKind(k)
                setTarget(null)
              }}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                kind === k
                  ? 'bg-accent font-medium text-slate-900 dark:text-slate-50'
                  : 'text-slate-600 hover:bg-muted dark:text-slate-300'
              }`}
            >
              <Icon aria-hidden className='h-3.5 w-3.5 shrink-0 text-slate-400' />
              {KIND_LABEL[k]}
            </button>
          )
        })}
      </div>
      {kind !== 'overdue' &&
        (opts.isLoading ? (
          <Skeleton className='h-24 w-full rounded-md' />
        ) : kind === 'step' ? (
          <PickList
            items={steps.map((s) => ({ value: s.key, label: s.label, color: s.color }))}
            value={target?.value ?? ''}
            onPick={(value, label) => setTarget({ value, label })}
            placeholder='Find a step'
            empty='No steps match'
          />
        ) : (
          <PickList
            items={fields.map((f) => ({ value: f.field, label: f.label }))}
            value={target?.value ?? ''}
            onPick={(value, label) => setTarget({ value, label })}
            placeholder='Find a field'
            empty='No fields match'
          />
        ))}
      {kind === 'overdue' && (
        <p className='px-2 text-[11.5px] leading-snug text-slate-500 dark:text-slate-400'>
          When its current step passes its due time. One alert per step it runs late on.
        </p>
      )}
      <div className='flex items-center justify-between gap-2 pt-0.5'>
        <Segmented
          label='How often'
          value={repeat}
          onChange={setRepeat}
          options={[
            { value: 'once', label: 'Once' },
            { value: 'always', label: 'Every time' }
          ]}
        />
        <button
          type='button'
          disabled={!ready || busy}
          onClick={() => void save()}
          className='rounded-md bg-nvr-cyan px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:hover:opacity-100'
        >
          {busy ? 'Adding…' : 'Add alert'}
        </button>
      </div>
    </div>
  )
}

/**
 * Where a popover opened from inside the dock goes: to the LEFT of the whole dock (rt6 review:
 * opened beside the bell it covered the dock's own header and tabs). A dock with no room on its
 * left (the phone sheet) opens it below the trigger instead.
 */
function besideDock(el: HTMLElement | null): { side: 'left' | 'bottom'; sideOffset: number } {
  const dock = el?.closest('[data-watch-dock]')
  if (!el || !dock) return { side: 'left', sideOffset: 6 }
  const d = dock.getBoundingClientRect()
  const t = el.getBoundingClientRect()
  if (d.left < 300) return { side: 'bottom', sideOffset: 4 }
  return { side: 'left', sideOffset: Math.max(6, Math.round(t.left - d.left) + 8) }
}

/** The quiet mark on a row that has alerts (the bell itself shows on hover). */
export function AlertMark({ row, actions }: { row: WatchRowData; actions: Actions }) {
  const mine = actions.prefs.alerts.filter((a) => a.key === row.key)
  if (mine.length === 0) return null
  const words = alertWords(mine[0]) + (mine.length > 1 ? ` +${mine.length - 1}` : '')
  return (
    <span data-tip={words} data-watch-alert-mark className='flex text-nvr-cyan'>
      <BellRing aria-hidden className='h-3 w-3' />
      <span className='sr-only'>Alert: {words}</span>
    </span>
  )
}

/**
 * "For you" on a record the list pinned itself because it landed on the person's step (rt6
 * review: an auto pin looked like any other). Says whether it leaves on its own.
 */
export function AutoPinMark({ row, actions }: { row: WatchRowData; actions: Actions }) {
  const pin = actions.prefs.pins.find((p) => p.key === row.key)
  if (!pin?.auto) return null
  const tip = actions.prefs.settings.auto_remove
    ? 'Pinned for you: it landed on your step. It unpins when it leaves your step.'
    : 'Pinned for you: it landed on your step.'
  return (
    <span
      data-tip={tip}
      data-watch-auto-pin
      className='inline-flex h-4 items-center rounded px-1 text-[10px] font-medium text-slate-500 ring-1 ring-inset ring-slate-200 dark:text-slate-400 dark:ring-white/[0.12]'
    >
      For you
      <span className='sr-only'>. {tip}</span>
    </span>
  )
}

/** The bell on a watched row: its alert rules, and a form to add one. */
export function AlertButton({ row, actions }: { row: WatchRowData; actions: Actions }) {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [place, setPlace] = useState<ReturnType<typeof besideDock>>({
    side: 'left',
    sideOffset: 6
  })
  const trigger = useRef<HTMLButtonElement>(null)
  const mine = actions.prefs.alerts.filter((a) => a.key === row.key)
  const has = mine.length > 0
  const title = row.title ?? row.collection_label
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setPlace(besideDock(trigger.current))
          setAdding(!has)
        }
        setOpen(o)
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type='button'
          aria-label={has ? `Alerts on ${title} (${mine.length})` : `Add an alert on ${title}`}
          data-tip={
            has
              ? alertWords(mine[0]) + (mine.length > 1 ? ` +${mine.length - 1}` : '')
              : 'Alert me when…'
          }
          data-watch-alert={has ? 'on' : 'off'}
          onClick={(e) => e.stopPropagation()}
          className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors focus-visible:visible focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 group-hover/row:visible ${
            open ? '' : 'invisible'
          } ${
            has
              ? 'text-nvr-cyan hover:bg-nvr-cyan/10'
              : 'text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-white/[0.08] dark:hover:text-slate-200'
          }`}
        >
          {has ? <BellRing className='h-3.5 w-3.5' /> : <Bell className='h-3.5 w-3.5' />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={place.side === 'left' ? 'start' : 'end'}
        side={place.side}
        sideOffset={place.sideOffset}
        // Clear of the app's top bar, aligned with the row it belongs to.
        collisionPadding={{ top: 56, bottom: 12, left: 12, right: 12 }}
        className='w-[296px] max-w-[calc(100vw-24px)] p-3'
        onClick={(e) => e.stopPropagation()}
      >
        <p className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
          Tell me when…
        </p>
        <p className='mb-2 truncate text-[11.5px] text-slate-500 dark:text-slate-400'>{title}</p>
        {has && (
          <ul className='mb-2 space-y-0.5' aria-label='Alerts on this record'>
            {mine.map((a) => (
              <li
                key={a.id}
                className='flex items-start gap-2 rounded-md bg-slate-50 py-1 pl-2 pr-1 text-[12px] text-slate-700 dark:bg-white/[0.04] dark:text-slate-200'
              >
                <BellRing aria-hidden className='mt-[3px] h-3 w-3 shrink-0 text-nvr-cyan' />
                {/* The whole rule, wrapped: a step name is the point of it. */}
                <span className='min-w-0 flex-1 break-words py-px leading-snug'>
                  {alertWords(a)}
                </span>
                <button
                  type='button'
                  aria-label={`Remove alert: ${alertWords(a)}`}
                  onClick={() => void actions.removeAlert(a.id).catch(() => {})}
                  className='flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-white/[0.08] dark:hover:text-slate-200'
                >
                  <X className='h-3 w-3' />
                </button>
              </li>
            ))}
          </ul>
        )}
        {adding ? (
          <AlertForm row={row} actions={actions} onDone={() => setAdding(false)} />
        ) : (
          <button
            type='button'
            onClick={() => setAdding(true)}
            className='flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-slate-700 hover:bg-muted dark:text-slate-200'
          >
            <Plus className='h-3.5 w-3.5' />
            Add another
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ── Shared list editor ──────────────────────────────────────────────────────────

interface Person {
  id: string
  name: string
  email?: string | null
}

function PeoplePicker({
  value,
  onChange,
  meId
}: {
  value: Person[]
  onChange: (p: Person[]) => void
  meId: string | null
}) {
  const client = useOptionalNivaroClient()
  const [q, setQ] = useState('')
  const term = q.trim()
  const found = useQuery({
    queryKey: ['watch-list', 'people', term],
    queryFn: () =>
      (client as Client)
        .request<{
          data: Array<{
            id: string
            first_name: string | null
            last_name: string | null
            email: string | null
          }>
        }>(get('/users', { search: term, limit: 8 }))
        .then((r) =>
          (r.data ?? []).map((u) => ({
            id: String(u.id),
            name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Someone',
            email: u.email
          }))
        ),
    enabled: !!client && term.length > 1,
    staleTime: 30_000
  })
  const chosen = new Set(value.map((p) => p.id.toLowerCase()))
  const options = (found.data ?? []).filter((p) => !chosen.has(p.id.toLowerCase()))
  return (
    <div>
      {value.length > 0 && (
        <ul className='mb-2 flex flex-wrap gap-1.5' aria-label='People on this list'>
          {value.map((p) => (
            <li
              key={p.id}
              className='inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2.5 pr-1 text-[12px] text-slate-700 dark:bg-white/[0.07] dark:text-slate-200'
            >
              {p.name}
              {meId && p.id.toLowerCase() === meId.toLowerCase() && (
                <span className='text-slate-500 dark:text-slate-400'>(you)</span>
              )}
              <button
                type='button'
                aria-label={`Take ${p.name} off the list`}
                onClick={() => onChange(value.filter((x) => x.id !== p.id))}
                className='flex h-4 w-4 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-white/[0.1] dark:hover:text-slate-200'
              >
                <X className='h-2.5 w-2.5' />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className='relative'>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='Add someone by name'
          aria-label='Add someone by name'
          className='h-8 w-full rounded-md border border-border bg-background px-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-slate-100'
        />
        {term.length > 1 && (options.length > 0 || found.isSuccess) && (
          <div
            role='listbox'
            aria-label='People'
            className='absolute left-0 right-0 z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md'
          >
            {options.length === 0 && (
              <p className='px-2 py-1.5 text-[12px] text-slate-500 dark:text-slate-400'>
                Nobody else matches
              </p>
            )}
            {options.map((p) => (
              <button
                key={p.id}
                type='button'
                role='option'
                aria-selected={false}
                onClick={() => {
                  onChange([...value, p])
                  setQ('')
                }}
                className='block w-full rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-slate-200'
              >
                {p.name}
                {p.email && (
                  <span className='ml-1.5 text-[11px] text-slate-500 dark:text-slate-400'>
                    {p.email}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Make or change a shared list, in place of the dock's tab body. */
export function TeamEditor({
  actions,
  team,
  meId,
  meName,
  onClose,
  onCreated
}: {
  actions: Actions
  team: WatchTeam | null
  meId: string | null
  meName: string
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [name, setName] = useState(team?.name ?? '')
  const [people, setPeople] = useState<Person[]>(() =>
    team
      ? team.members.map((m) => ({ id: m.id, name: m.name }))
      : meId
        ? [{ id: meId, name: meName || 'You' }]
        : []
  )
  const [withReports, setWithReports] = useState(false)
  // New lists tidy themselves; a list from before keeps what its owner chose (off until set).
  const [removeDone, setRemoveDone] = useState<boolean>(team ? !!team.remove_completed : true)
  const [busy, setBusy] = useState(false)
  const reports = actions.prefs.direct_reports ?? 0
  const save = async () => {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    try {
      if (team) {
        await actions.editTeam(team.id, {
          name: n,
          members: people.map((p) => p.id),
          remove_completed: removeDone
        })
        onClose()
      } else {
        const id = await actions.createTeam({
          name: n,
          members: people.map((p) => p.id),
          reports: withReports,
          remove_completed: removeDone
        })
        if (id) onCreated(id)
        else onClose()
      }
    } catch {
      /* toasted */
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className='space-y-4 px-4 py-4'
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      data-watch-team-editor
    >
      <div>
        <p className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
          {team ? 'Change shared list' : 'New shared list'}
        </p>
        <p className='mt-0.5 text-[11.5px] leading-snug text-slate-500 dark:text-slate-400'>
          Everyone on it sees it as a tab here and can add records. Each person only sees the
          records they can open.
        </p>
      </div>
      <label className='block'>
        <span className='mb-1 block text-[12px] font-medium text-slate-700 dark:text-slate-200'>
          Name
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          placeholder='Night shift, Region East…'
          // biome-ignore lint/a11y/noAutofocus: the editor opens to type a name
          autoFocus
          className='h-8 w-full rounded-md border border-border bg-background px-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-slate-100'
        />
      </label>
      <div>
        <span className='mb-1 block text-[12px] font-medium text-slate-700 dark:text-slate-200'>
          People
        </span>
        <PeoplePicker value={people} onChange={setPeople} meId={meId} />
        {!team && reports > 0 && (
          <label className='mt-2 flex items-center gap-2 text-[12px] text-slate-700 dark:text-slate-200'>
            <input
              type='checkbox'
              checked={withReports}
              onChange={(e) => setWithReports(e.target.checked)}
              className='h-3.5 w-3.5 rounded border-slate-300 accent-[var(--nvr-cyan,#00ceff)]'
            />
            Add my direct reports ({reports})
          </label>
        )}
      </div>
      <label className='flex items-start gap-2 text-[12px] text-slate-700 dark:text-slate-200'>
        <input
          type='checkbox'
          checked={removeDone}
          onChange={(e) => setRemoveDone(e.target.checked)}
          className='mt-0.5 h-3.5 w-3.5 rounded border-slate-300 accent-[var(--nvr-cyan,#00ceff)]'
        />
        <span>
          Remove records when they’re completed
          <span className='mt-0.5 block text-[11.5px] leading-snug text-slate-500 dark:text-slate-400'>
            They show “Completed”, then leave the list 24 hours later. Recently removed keeps them 7
            days, with Undo.
          </span>
        </span>
      </label>
      <div className='flex items-center justify-end gap-2 pt-1'>
        <button
          type='button'
          onClick={onClose}
          className='rounded-md px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-muted dark:text-slate-300'
        >
          Cancel
        </button>
        <button
          type='submit'
          disabled={!name.trim() || busy}
          className='rounded-md bg-nvr-cyan px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:hover:opacity-100'
        >
          {busy ? 'Saving…' : team ? 'Save' : 'Make list'}
        </button>
      </div>
    </form>
  )
}

/** "Also on a shared list": beside a record's pin, for people who have shared lists. */
export function WatchShareMenu({
  actions,
  collection,
  itemId,
  size = 'md'
}: {
  actions: Actions
  collection: string
  itemId: string
  size?: 'sm' | 'md'
}) {
  // A list whose maker is gone is read-only until an administrator takes it over.
  const teams = actions.prefs.teams.filter((t) => (t.is_member || t.can_manage) && !t.owner_gone)
  const key = `${collection}:${itemId}`
  const onCount = teams.filter((t) => t.pins.some((p) => p.key === key)).length
  if (teams.length === 0) return null
  const icon = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={
            onCount > 0
              ? `On ${onCount} shared list${onCount === 1 ? '' : 's'}`
              : 'Add to a shared list'
          }
          data-tip={
            onCount > 0
              ? `On ${onCount} shared list${onCount === 1 ? '' : 's'}`
              : 'Add to a shared list'
          }
          data-watch-share={onCount > 0 ? 'on' : 'off'}
          onClick={(e) => e.stopPropagation()}
          className={`inline-flex shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 ${
            size === 'sm' ? 'h-6 w-6' : 'h-7 w-7'
          } ${
            onCount > 0
              ? 'text-nvr-cyan hover:bg-nvr-cyan/10'
              : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-white/[0.06] dark:hover:text-slate-300'
          }`}
        >
          <Users className={icon} />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-60 p-1' onClick={(e) => e.stopPropagation()}>
        <p className='px-2 pb-1 pt-1.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400'>
          Shared lists
        </p>
        {teams.map((t) => {
          const on = t.pins.some((p) => p.key === key)
          return (
            <button
              key={t.id}
              type='button'
              role='menuitemcheckbox'
              aria-checked={on}
              onClick={() =>
                void (
                  on
                    ? actions.teamUnpin(t.id, collection, itemId)
                    : actions.teamPin(t.id, collection, itemId)
                ).catch(() => {})
              }
              className='flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-slate-200'
            >
              <span
                aria-hidden
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                  on
                    ? 'border-nvr-cyan bg-nvr-cyan text-white'
                    : 'border-slate-300 dark:border-white/20'
                }`}
              >
                {on && <Check className='h-2.5 w-2.5' strokeWidth={3} />}
              </span>
              <span className='min-w-0 flex-1 truncate'>{t.name}</span>
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
