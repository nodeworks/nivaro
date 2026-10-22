import { Gauge, Radio, ServerCrash, Shuffle, Unplug, WifiOff, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CLIENT_CHAOS_MAX_FAIL_WRITES,
  CLIENT_CHAOS_STRENGTH,
  type ClientChaosPreset,
  type ClientChaosState,
  startClientChaos,
  stopClientChaos
} from '../lib/client-chaos'
import { cn } from '../lib/utils'
import { type ClientChaosUser, useClientChaos, useClientChaosGate } from './client-chaos-gate'
import { Skeleton } from './ui/skeleton'

/**
 * Personal chaos toolbar (#2856) — the screen for browser chaos mode (#2840). A small panel
 * anchored to the bottom-right corner: pick what breaks (flaky network, API down, slow API,
 * offline, socket gone, and/or "fail my next N saves"), how hard and for how long, then Start.
 * While it runs, a pill stays in the corner with what is on and the time left, so the person
 * never forgets; Stop is one click from either.
 *
 * Only this tab's own requests are touched. Shown only when the server's chaos gate allows it and
 * the person may use it (`canUseClientChaos`). Open it from a menu with
 * `openClientChaosToolbar()`, or with ⌘/Ctrl + Shift + . anywhere.
 */

const OPEN_EVENT = 'nvr:client-chaos-open'

/** Open the toolbar from anywhere (a user menu item, a command). */
export function openClientChaosToolbar(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_EVENT))
}

/** The keyboard shortcut, for menus that show it. */
export const CLIENT_CHAOS_SHORTCUT = '⌘⇧.'

const PRESETS: Array<{
  id: ClientChaosPreset
  label: string
  effect: string
  icon: ReactNode
}> = [
  {
    id: 'flaky',
    label: 'Flaky network',
    effect: 'Some requests fail, the rest lag',
    icon: <Shuffle className='h-3.5 w-3.5' />
  },
  {
    id: 'api-down',
    label: 'API down',
    effect: 'Every API call answers 503',
    icon: <ServerCrash className='h-3.5 w-3.5' />
  },
  {
    id: 'slow',
    label: 'Slow API',
    effect: 'Every API call waits longer',
    icon: <Gauge className='h-3.5 w-3.5' />
  },
  {
    id: 'offline',
    label: 'Offline',
    effect: 'Requests fail as if the network is gone',
    icon: <WifiOff className='h-3.5 w-3.5' />
  },
  {
    id: 'socket-gone',
    label: 'Socket gone',
    effect: 'Live updates stop, then reconnect at the end',
    icon: <Radio className='h-3.5 w-3.5' />
  }
]

const DURATIONS = [
  { ms: 60_000, label: '1 min' },
  { ms: 5 * 60_000, label: '5 min' },
  { ms: 15 * 60_000, label: '15 min' },
  { ms: 30 * 60_000, label: '30 min' }
]

const PRESET_LABEL: Record<ClientChaosPreset, string> = Object.fromEntries(
  PRESETS.map((p) => [p.id, p.label])
) as Record<ClientChaosPreset, string>

function strengthText(preset: ClientChaosPreset | null, strength: number): string | null {
  if (preset === 'flaky') return `${strength}% of requests fail`
  if (preset === 'slow')
    return `+${(strength / 1000).toFixed(strength % 1000 === 0 ? 0 : 2)} s each`
  return null
}

/** What is on, in a few words: "API down · 3 saves left". */
export function clientChaosSummary(s: ClientChaosState): string {
  const parts: string[] = []
  if (s.preset) parts.push(PRESET_LABEL[s.preset])
  if (s.failWrites > 0) parts.push(`${s.failWrites} save${s.failWrites === 1 ? '' : 's'} to fail`)
  return parts.join(' · ') || 'Browser chaos'
}

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export interface ClientChaosToolbarProps {
  /** The signed-in person (`is_admin`, and `masquerade` in a View-as tab). */
  user: ClientChaosUser | undefined
  /** ⌘/Ctrl + Shift + . toggles the panel (default on). */
  shortcut?: boolean
}

export function ClientChaosToolbar({ user, shortcut = true }: ClientChaosToolbarProps) {
  const gate = useClientChaosGate(user)
  const chaos = useClientChaos()
  const [open, setOpen] = useState(false)
  const now = useNow(chaos !== null)

  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])
  useEffect(() => {
    if (!shortcut) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.code !== 'Period') return
      e.preventDefault()
      setOpen((o) => !o)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcut])

  // No chaos on this server (or not this person's to use): nothing renders, not even the pill.
  if (!gate.present && !gate.loading) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <>
      {open && <ChaosPanel gate={gate} chaos={chaos} now={now} onClose={() => setOpen(false)} />}
      {!open && chaos && gate.allowed && (
        <ChaosPill chaos={chaos} now={now} onOpen={() => setOpen(true)} />
      )}
    </>,
    document.body
  )
}

/**
 * Always-dark corner pill (it must read on any page, light or dark). It sits left of the corner
 * where hosts keep their round report-a-problem button, so neither hides the other.
 */
function ChaosPill({
  chaos,
  now,
  onOpen
}: {
  chaos: ClientChaosState
  now: number
  onOpen: () => void
}) {
  return (
    <div
      data-client-chaos-pill=''
      className='nvr-chaos-enter fixed right-[60px] bottom-4 z-[70] flex max-w-[calc(100vw-76px)] items-center rounded-full border border-white/10 bg-[#0f172a] text-[12px] text-slate-100 shadow-lg'
    >
      <style>{ENTER_CSS}</style>
      <button
        type='button'
        onClick={onOpen}
        data-tip='Browser chaos is on in this tab — open the controls'
        className='flex min-w-0 items-center gap-2 rounded-l-full py-1.5 pr-2 pl-3 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
      >
        <span className='relative flex h-2 w-2 shrink-0'>
          <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60 motion-reduce:animate-none' />
          <span className='relative inline-flex h-2 w-2 rounded-full bg-amber-400' />
        </span>
        <span className='truncate font-medium'>{clientChaosSummary(chaos)}</span>
        <span className='shrink-0 font-mono text-[11.5px] tabular-nums text-slate-400'>
          {clock(chaos.endsAt - now)}
        </span>
      </button>
      <button
        type='button'
        aria-label='Stop browser chaos'
        data-tip='Stop now'
        onClick={stopClientChaos}
        className='flex h-7 w-7 shrink-0 items-center justify-center rounded-r-full border-l border-white/10 text-slate-400 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
      >
        <X className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}

const ENTER_CSS = `
@keyframes nvr-chaos-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
.nvr-chaos-enter { animation: nvr-chaos-in 180ms cubic-bezier(0.22, 1, 0.36, 1) backwards }
@media (prefers-reduced-motion: reduce) { .nvr-chaos-enter { animation: none } }
`

function ChaosPanel({
  gate,
  chaos,
  now,
  onClose
}: {
  gate: ReturnType<typeof useClientChaosGate>
  chaos: ClientChaosState | null
  now: number
  onClose: () => void
}) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // Focus lands inside, so the keyboard can drive it at once.
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      ref={ref}
      role='dialog'
      aria-modal='false'
      aria-labelledby={titleId}
      data-client-chaos-panel=''
      className='nvr-chaos-enter fixed right-4 bottom-4 left-4 z-[70] max-h-[calc(100vh-32px)] overflow-y-auto overscroll-contain rounded-lg border border-slate-200 bg-white text-slate-900 shadow-xl sm:left-auto sm:w-[340px] dark:border-border dark:bg-card dark:text-foreground'
    >
      <style>{ENTER_CSS}</style>
      <div className='flex items-start gap-2.5 border-b border-slate-100 px-4 pt-3.5 pb-3 dark:border-border'>
        <Unplug className='mt-0.5 h-4 w-4 shrink-0 text-slate-400' />
        <div className='min-w-0 flex-1'>
          <h2 id={titleId} className='text-[13.5px] font-semibold leading-tight'>
            Browser chaos
          </h2>
          <p className='mt-0.5 text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
            Breaks this tab’s own requests on purpose. Nobody else is affected.
          </p>
        </div>
        <button
          type='button'
          aria-label='Close'
          data-tip={`Close (${CLIENT_CHAOS_SHORTCUT})`}
          onClick={onClose}
          className='-mt-0.5 -mr-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-muted hover:text-slate-700 dark:hover:text-foreground'
        >
          <X className='h-4 w-4' />
        </button>
      </div>
      {gate.loading ? (
        <div className='space-y-2.5 px-4 py-4' aria-busy='true'>
          <Skeleton className='h-3.5 w-2/3' />
          <Skeleton className='h-3.5 w-1/2' />
          <Skeleton className='h-8 w-full' />
        </div>
      ) : !gate.allowed ? (
        <div className='px-4 py-4 text-[12.5px]'>
          <p className='font-medium'>Browser chaos is off here</p>
          <p className='mt-1 text-slate-500 dark:text-muted-foreground'>
            {gate.reason ?? 'This server does not allow chaos drills.'}
          </p>
        </div>
      ) : chaos ? (
        <RunningView chaos={chaos} now={now} />
      ) : (
        <SetupView />
      )}
    </div>
  )
}

function RunningView({ chaos, now }: { chaos: ClientChaosState; now: number }) {
  const total = chaos.endsAt - chaos.startedAt
  const left = Math.max(0, chaos.endsAt - now)
  const strength = strengthText(chaos.preset, chaos.strength)
  return (
    <div className='px-4 py-4'>
      <div className='flex items-center gap-2'>
        <span className='relative flex h-2 w-2 shrink-0'>
          <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60 motion-reduce:animate-none' />
          <span className='relative inline-flex h-2 w-2 rounded-full bg-amber-500' />
        </span>
        <p className='min-w-0 flex-1 truncate text-[13px] font-medium'>
          {clientChaosSummary(chaos)}
        </p>
        <span className='shrink-0 font-mono text-[13px] tabular-nums text-slate-700 dark:text-foreground'>
          <span className='sr-only'>Ends in </span>
          {clock(left)}
        </span>
      </div>
      {strength && (
        <p className='mt-1 pl-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
          {strength}
        </p>
      )}
      <div className='mt-3 h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.08]'>
        <div
          className='h-full rounded-full bg-amber-400 transition-[width] duration-1000 ease-linear motion-reduce:transition-none'
          style={{ width: `${total > 0 ? (left / total) * 100 : 0}%` }}
        />
      </div>
      <p className='mt-2.5 text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
        Ends on its own when the time runs out, and stays on through a reload. Signing out and this
        panel keep working throughout.
      </p>
      <button
        type='button'
        data-autofocus=''
        onClick={stopClientChaos}
        className='mt-3.5 inline-flex h-8 w-full items-center justify-center rounded-md bg-red-600 text-[12.5px] font-medium text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:ring-offset-2 dark:ring-offset-card'
      >
        Stop now
      </button>
    </div>
  )
}

function SetupView() {
  const [preset, setPreset] = useState<ClientChaosPreset | null>('flaky')
  const [strength, setStrength] = useState<Record<'flaky' | 'slow', number>>({
    flaky: CLIENT_CHAOS_STRENGTH.flaky.initial,
    slow: CLIENT_CHAOS_STRENGTH.slow.initial
  })
  const [failSaves, setFailSaves] = useState(false)
  const [saves, setSaves] = useState(3)
  const [duration, setDuration] = useState(5 * 60_000)
  const groupLabel = useId()

  const range = preset === 'flaky' || preset === 'slow' ? CLIENT_CHAOS_STRENGTH[preset] : null
  const value = preset === 'flaky' || preset === 'slow' ? strength[preset] : 0
  const canStart = preset !== null || failSaves

  const start = useCallback(() => {
    if (!canStart) return
    startClientChaos({
      preset,
      durationMs: duration,
      strength: value,
      failWrites: failSaves ? saves : 0
    })
  }, [canStart, preset, duration, value, failSaves, saves])

  return (
    <div className='px-4 pt-3 pb-4'>
      <p
        id={groupLabel}
        className='mb-1.5 text-[12px] font-medium text-slate-600 dark:text-slate-300'
      >
        What breaks
      </p>
      <fieldset aria-labelledby={groupLabel} className='-mx-1.5 min-w-0 space-y-px'>
        {PRESETS.map((p, i) => {
          const on = preset === p.id
          return (
            <button
              key={p.id}
              type='button'
              aria-pressed={on}
              data-autofocus={i === 0 ? '' : undefined}
              // A second click clears it, leaving "fail my next saves" on its own.
              onClick={() => setPreset(on ? null : p.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                on ? 'bg-accent' : 'hover:bg-muted'
              )}
            >
              <span
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                  on
                    ? 'bg-nvr-cyan/15 text-nvr-cyan'
                    : 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-muted-foreground'
                )}
              >
                {p.icon}
              </span>
              <span className='min-w-0 flex-1'>
                <span className='block text-[12.5px] font-medium leading-tight'>{p.label}</span>
                <span className='block truncate text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
                  {p.effect}
                </span>
              </span>
              <span
                aria-hidden
                className={cn(
                  'h-3.5 w-3.5 shrink-0 rounded-full border',
                  on ? 'border-[4px] border-nvr-cyan' : 'border-slate-300 dark:border-white/[0.2]'
                )}
              />
            </button>
          )
        })}
      </fieldset>

      {range && (preset === 'flaky' || preset === 'slow') && (
        <label className='mt-3 block'>
          <span className='flex items-baseline justify-between text-[12px]'>
            <span className='font-medium text-slate-600 dark:text-slate-300'>Strength</span>
            <span className='text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'>
              {strengthText(preset, value)}
            </span>
          </span>
          <input
            type='range'
            min={range.min}
            max={range.max}
            step={range.step}
            value={value}
            onChange={(e) => setStrength((s) => ({ ...s, [preset]: Number(e.target.value) }))}
            className='mt-1 w-full accent-nvr-cyan'
          />
        </label>
      )}

      <div className='mt-3 flex items-center gap-2 border-t border-slate-100 pt-3 dark:border-border'>
        <label className='flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-[12.5px]'>
          <input
            type='checkbox'
            checked={failSaves}
            onChange={(e) => setFailSaves(e.target.checked)}
            className='h-3.5 w-3.5 accent-nvr-cyan'
          />
          <span className='truncate'>Fail my next saves</span>
        </label>
        <div
          className={cn(
            'flex shrink-0 items-center rounded-md border border-slate-200 dark:border-border',
            !failSaves && 'opacity-50'
          )}
        >
          <button
            type='button'
            aria-label='Fewer saves'
            disabled={!failSaves || saves <= 1}
            onClick={() => setSaves((n) => Math.max(1, n - 1))}
            className='h-7 w-7 text-[14px] text-slate-500 hover:bg-muted disabled:pointer-events-none'
          >
            −
          </button>
          <span aria-live='polite' className='w-7 text-center font-mono text-[12px] tabular-nums'>
            {saves}
          </span>
          <button
            type='button'
            aria-label='More saves'
            disabled={!failSaves || saves >= CLIENT_CHAOS_MAX_FAIL_WRITES}
            onClick={() => setSaves((n) => Math.min(CLIENT_CHAOS_MAX_FAIL_WRITES, n + 1))}
            className='h-7 w-7 text-[14px] text-slate-500 hover:bg-muted disabled:pointer-events-none'
          >
            +
          </button>
        </div>
      </div>
      <p className='mt-1 pl-[22px] text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        Creates, edits and deletes answer 500; reads still work.
      </p>

      <p className='mt-3 mb-1.5 text-[12px] font-medium text-slate-600 dark:text-slate-300'>For</p>
      <div className='grid grid-cols-4 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
        {DURATIONS.map((d) => (
          <button
            key={d.ms}
            type='button'
            aria-pressed={duration === d.ms}
            onClick={() => setDuration(d.ms)}
            className={cn(
              'h-7 text-[12px] focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
              duration === d.ms
                ? 'bg-accent font-medium text-slate-900 dark:text-foreground'
                : 'bg-white text-slate-600 hover:bg-muted dark:bg-card dark:text-muted-foreground'
            )}
          >
            {d.label}
          </button>
        ))}
      </div>

      <button
        type='button'
        disabled={!canStart}
        onClick={start}
        className='mt-4 inline-flex h-8 w-full items-center justify-center rounded-md bg-nvr-cyan text-[12.5px] font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 dark:ring-offset-card'
      >
        {canStart
          ? `Start for ${DURATIONS.find((d) => d.ms === duration)?.label}`
          : 'Pick what breaks'}
      </button>
    </div>
  )
}
