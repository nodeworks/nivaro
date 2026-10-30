import {
  AlertOctagon,
  Bookmark,
  Check,
  Clock,
  Keyboard,
  Link2,
  Maximize2,
  Minimize2,
  RefreshCw,
  SlidersHorizontal,
  Tv
} from 'lucide-react'
import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { applySavedView } from './Customize'
import { freshness } from './freshness'
import { RegionPicker } from './panels/RegionPicker'
import { SystemPill } from './panels/SystemPanel'
import { BriefButton, TimeBar } from './panels/TimeBar'
import { useNow } from './shell-hooks'
import { SHORTCUTS } from './shortcuts'
import { useCc } from './state'
import { ccVars, FAINT, FOCUS, ICON_BUTTON, SKELETON } from './theme'
import { currentViewUrl } from './url-state'

/**
 * Board header: title, lenses (region, time), headline numbers, system pill, how fresh the data
 * is, and the board's own controls (copy link, TV, full screen, customise, shortcuts, refresh).
 * Wraps cleanly on a phone: the controls drop to their own line.
 */
export function Header({
  helpOpen,
  onHelpOpenChange,
  kioskLabel
}: {
  helpOpen: boolean
  onHelpOpenChange: (v: boolean) => void
  /** On a wallboard link: the screen's name, shown beside the title. */
  kioskLabel?: string | null
}) {
  const cc = useCc()
  const snap = cc.snapshot
  const t = snap?.throughput
  const delta = t ? t.transitions_today - t.transitions_yesterday_same_time : 0
  const kiosk = !!cc.kiosk
  return (
    <header className='flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2'>
      <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-[var(--cc-strong)]'>
        Command Center
        {kioskLabel && (
          <span className='ml-2 text-[13px] font-normal text-[var(--cc-muted)]'>{kioskLabel}</span>
        )}
      </h1>
      <RegionPicker />
      <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-[var(--cc-text)]'>
        {snap ? (
          <span className='flex items-center gap-1.5'>
            <span className='h-2 w-2 rounded-full bg-[var(--cc-people)]' aria-hidden />
            <b className='font-semibold tabular-nums'>{snap.people.online_count}</b> online
            {snap.people.idle_count > 0 && (
              <span className={FAINT}>· {snap.people.idle_count} idle</span>
            )}
          </span>
        ) : cc.snapshotLoading ? (
          <span className={`${SKELETON} h-4 w-20`} aria-hidden />
        ) : null}
        {t ? (
          <span>
            <b className='font-semibold tabular-nums'>{t.transitions_today}</b> moves today{' '}
            <span
              className={delta >= 0 ? 'text-[var(--cc-good-text)]' : 'text-[var(--cc-warn-text)]'}
            >
              ({delta >= 0 ? '+' : '−'}
              {Math.abs(delta)} on yesterday)
            </span>
          </span>
        ) : cc.snapshotLoading ? (
          <span className={`${SKELETON} h-4 w-40`} aria-hidden />
        ) : null}
        {snap && <DeadlineChips risk={snap.risk} />}
        {snap && snap.risk.open_issues > 0 && (
          <button
            type='button'
            disabled={kiosk}
            onClick={() => cc.navigate('/issues')}
            className={`rounded-full bg-[var(--cc-bad-bg)] px-2.5 py-0.5 text-[12px] font-medium text-[var(--cc-bad-text)] enabled:hover:brightness-95 disabled:cursor-default ${FOCUS}`}
          >
            {snap.risk.open_issues} open {snap.risk.open_issues === 1 ? 'issue' : 'issues'}
          </button>
        )}
        <SystemPill />
      </div>
      <div className='ml-auto flex flex-wrap items-center gap-x-3 gap-y-2'>
        <TimeBar />
        <BriefButton />
        <FreshnessLabel />
        <div className='flex items-center gap-0.5' role='toolbar' aria-label='Board controls'>
          {!kiosk && <SavedViewsMenu />}
          {!kiosk && <CopyLinkButton />}
          <button
            type='button'
            className={ICON_BUTTON}
            aria-pressed={cc.tv}
            aria-label={cc.tv ? 'Leave TV mode' : 'TV mode'}
            data-tip={cc.tv ? 'Leave TV mode (T)' : 'TV mode — larger type, cycles regions (T)'}
            onClick={() => cc.setTv(!cc.tv)}
          >
            <Tv className='h-4 w-4' aria-hidden />
          </button>
          <button
            type='button'
            className={ICON_BUTTON}
            aria-pressed={cc.fullscreen}
            aria-label={cc.fullscreen ? 'Leave full screen' : 'Full screen'}
            data-tip={cc.fullscreen ? 'Leave full screen (F)' : 'Full screen (F)'}
            onClick={cc.toggleFullscreen}
          >
            {cc.fullscreen ? (
              <Minimize2 className='h-4 w-4' aria-hidden />
            ) : (
              <Maximize2 className='h-4 w-4' aria-hidden />
            )}
          </button>
          {!kiosk && (
            <button
              type='button'
              className={ICON_BUTTON}
              aria-label='Customise the board'
              data-tip='Customise'
              onClick={cc.openCustomize}
            >
              <SlidersHorizontal className='h-4 w-4' aria-hidden />
            </button>
          )}
          <ShortcutsButton open={helpOpen} onOpenChange={onHelpOpenChange} />
          <button
            type='button'
            className={ICON_BUTTON}
            aria-label='Refresh now'
            data-tip='Refresh now (R)'
            onClick={cc.refresh}
          >
            <RefreshCw className='h-4 w-4' aria-hidden />
          </button>
        </div>
      </div>
    </header>
  )
}

/** Move to the Needs attention panel (scrolled into view and focused, for keyboards too). */
export function goToAttention() {
  // The panel's own root, else the shell's slot around it.
  const el = document.querySelector<HTMLElement>(
    "[data-cc-panel='attention'], [data-cc-slot='attention']"
  )
  if (!el) return
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' })
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
  el.focus({ preventScroll: true })
}

/**
 * "N past deadline" (red) / "N near deadline" (amber) — icon + words, never colour alone. An
 * undefined count means the server could not say: the chip is hidden, not shown as zero.
 */
export function DeadlineChips({ risk }: { risk: { sla_breached?: number; sla_warning?: number } }) {
  const chip =
    'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium enabled:hover:brightness-95'
  return (
    <>
      {risk.sla_breached !== undefined && risk.sla_breached > 0 && (
        <button
          type='button'
          onClick={goToAttention}
          className={`${chip} bg-[var(--cc-bad-bg)] text-[var(--cc-bad-text)] ${FOCUS}`}
        >
          <AlertOctagon className='h-3.5 w-3.5' aria-hidden />
          <span className='tabular-nums'>{risk.sla_breached}</span> past deadline
        </button>
      )}
      {risk.sla_warning !== undefined && risk.sla_warning > 0 && (
        <button
          type='button'
          onClick={goToAttention}
          className={`${chip} bg-[var(--cc-warn-bg)] text-[var(--cc-warn-text)] ${FOCUS}`}
        >
          <Clock className='h-3.5 w-3.5' aria-hidden />
          <span className='tabular-nums'>{risk.sla_warning}</span> near deadline
        </button>
      )}
    </>
  )
}

/** "Updated 6s ago", live; after two failed polls the stale warning with Try again. */
function FreshnessLabel() {
  const cc = useCc()
  const now = useNow(1000, !!cc.updatedAt)
  const f = freshness({ updatedAt: cc.updatedAt, failures: cc.snapshotFailures, now })
  if (f.kind === 'loading') return <span className={`${SKELETON} h-4 w-24`} aria-hidden />
  if (f.kind === 'fresh')
    return <span className={`text-[12px] tabular-nums ${FAINT}`}>{f.label}</span>
  return (
    <span
      role='status'
      className='inline-flex items-center gap-1.5 rounded-full bg-[var(--cc-warn-bg)] px-2.5 py-0.5 text-[12px] text-[var(--cc-warn-text)]'
    >
      {f.kind === 'stale'
        ? `Couldn’t refresh — showing data from ${f.since}`
        : 'Couldn’t load the board'}
      <span aria-hidden>·</span>
      <button
        type='button'
        onClick={cc.refresh}
        className={`font-medium underline underline-offset-2 hover:no-underline ${FOCUS}`}
      >
        Try again
      </button>
    </span>
  )
}

function CopyLinkButton() {
  const [copied, setCopied] = useState(false)
  return (
    <>
      <button
        type='button'
        className={ICON_BUTTON}
        aria-label={copied ? 'Link copied' : 'Copy a link to this view'}
        data-tip={copied ? 'Copied' : 'Copy a link to this view'}
        onClick={() => {
          const url = currentViewUrl()
          void navigator.clipboard?.writeText(url).then(
            () => {
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            },
            () => setCopied(false)
          )
        }}
      >
        {copied ? (
          <Check className='h-4 w-4' aria-hidden />
        ) : (
          <Link2 className='h-4 w-4' aria-hidden />
        )}
      </button>
      <span className='sr-only' aria-live='polite'>
        {copied ? 'Link to this view copied' : ''}
      </span>
    </>
  )
}

function SavedViewsMenu() {
  const cc = useCc()
  const views = cc.prefs?.saved_views ?? []
  if (views.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type='button'
          className={ICON_BUTTON}
          aria-label='Saved views'
          data-tip='Saved views'
        >
          <Bookmark className='h-4 w-4' aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align='end'
        style={ccVars(cc.mode)}
        className='min-w-[200px] border-[var(--cc-border)] bg-[var(--cc-panel)] text-[var(--cc-text)]'
      >
        {views.map((v) => (
          <DropdownMenuItem
            key={v.id}
            className='text-[12.5px] focus:bg-[var(--cc-chip-hover)] focus:text-[var(--cc-strong)]'
            onSelect={() => applySavedView(cc, v)}
          >
            {v.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem
          className='text-[12px] text-[var(--cc-muted)] focus:bg-[var(--cc-chip-hover)]'
          onSelect={cc.openCustomize}
        >
          Manage views…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ShortcutsButton({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const cc = useCc()
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={ICON_BUTTON}
          aria-label='Keyboard shortcuts'
          data-tip='Keyboard shortcuts (?)'
        >
          <Keyboard className='h-4 w-4' aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        style={ccVars(cc.mode)}
        className='w-72 border-[var(--cc-border)] bg-[var(--cc-panel)] p-3 text-[var(--cc-text)]'
      >
        <h2 className='mb-2 text-[13px] font-semibold text-[var(--cc-strong)]'>
          Keyboard shortcuts
        </h2>
        <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12.5px]'>
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className='contents'>
              <dt>
                <kbd className='inline-block min-w-[1.75rem] rounded border border-[var(--cc-border)] bg-[var(--cc-raised)] px-1.5 text-center font-mono text-[11.5px] text-[var(--cc-strong)]'>
                  {s.keys}
                </kbd>
              </dt>
              <dd className='text-[var(--cc-muted)]'>{s.label}</dd>
            </div>
          ))}
        </dl>
        <p className={`mt-2 text-[11.5px] ${FAINT}`}>Shortcuts pause while you type in a field.</p>
      </PopoverContent>
    </Popover>
  )
}
