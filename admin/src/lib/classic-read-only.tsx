import { isDesignAllowedRequest } from '@nivaro/shared'
import type { AxiosInstance } from 'axios'
import { CanceledError } from 'axios'
import { Lock } from 'lucide-react'
import { type ReactNode, type SyntheticEvent, useEffect } from 'react'
import { api } from '@/lib/api'

// The classic Layouts tab, kept for comparison while the new editor proves
// parity (spec §9 items 7 and 15), may not change anything. Two layers: every
// configuration write made through admin's axios while it is open is refused
// before it leaves the browser, and the controls that would write are inert.

export const CLASSIC_READ_ONLY_MESSAGE = 'Read-only — use the new editor'

/**
 * The configuration the classic Layouts tab writes. A deny-list, not an
 * allow-list: the page around it (sign-out, workspace switch, favorites,
 * header actions) keeps writing and must keep working. The DOM guards are the
 * primary layer; this catches what slips past them.
 */
const CONFIG_WRITES =
  /^\/(collection-layouts|field-groups|field-config|fields|collections|data-model|widgets-internal|custom-actions|attribute-definitions|ai-settings|ai-design|ai-explain|item-locks\/config|draft-publish|collection-snapshots)(\/|$)/

/** Whether a request may go out while the classic layout editor is open. */
export function classicAllows(method: string | undefined, url: string | undefined): boolean {
  const m = (method ?? 'get').toUpperCase()
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true
  const path = (url ?? '').split('?')[0].replace(/^(https?:\/\/[^/]+)?\/api(?=\/)/, '')
  if (isDesignAllowedRequest({ _method: m, _path: path })) return true
  return !CONFIG_WRITES.test(path)
}

/** Refuse every configuration write on `instance`; returns the undo. */
export function installClassicReadOnlyGuard(
  instance: AxiosInstance,
  onRefused?: (w: { method: string; path: string }) => void
): () => void {
  const id = instance.interceptors.request.use((config) => {
    if (classicAllows(config.method, config.url)) return config
    onRefused?.({ method: (config.method ?? 'get').toUpperCase(), path: config.url ?? '' })
    throw new CanceledError(CLASSIC_READ_ONLY_MESSAGE)
  })
  return () => instance.interceptors.request.eject(id)
}

// Controls that only open, expand, switch or navigate — still usable.
const SAFE =
  'a[href], summary, [role="tab"], [aria-haspopup]:not([aria-haspopup="false"]), [aria-expanded], [data-classic-nav]'
// Controls that act.
const ACTION =
  'button, [role="button"], [role^="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"], [role="slider"], label, input, select, textarea, [contenteditable]:not([contenteditable="false"])'
const TEXT_INPUT =
  'textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="range"]):not([type="color"]):not([type="file"])'
const SORTABLE = '[aria-roledescription="sortable"], [draggable="true"]'
const READ_KEYS = new Set([
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Shift',
  'Control',
  'Alt',
  'Meta'
])

const targetOf = (e: SyntheticEvent) => e.target as Element | null

/** The nearest control the event lands on, or null for plain content. */
function controlOf(t: Element | null): Element | null {
  return t?.closest?.(`${SAFE}, ${ACTION}`) ?? null
}

const isSafe = (el: Element | null) => !!el?.matches(SAFE)
const isText = (t: Element | null) => !!t?.closest?.(TEXT_INPUT)
const inSortable = (t: Element | null) => !!t?.closest?.(SORTABLE)

function block(e: SyntheticEvent) {
  e.preventDefault()
  e.stopPropagation()
}

/** Would this click act (and so write)? Opening, expanding and switching layouts stay usable. */
export function classicBlocksClick(t: Element | null): boolean {
  const control = controlOf(t)
  if (!control || isSafe(control)) return false
  // Clicking into a text box only focuses it; typing is refused separately.
  return !control.matches(TEXT_INPUT)
}

/**
 * The classic Layouts tab, read-only: a banner, a request guard on admin's
 * axios for as long as it is open, and capture-phase guards (they see events
 * from popovers and menus too — React events travel through portals) that
 * keep every control that writes inert.
 */
export function ClassicReadOnly({
  onOpenNew,
  children
}: {
  /** Leave for the new editor. */
  onOpenNew: () => void
  children: ReactNode
}) {
  useEffect(() => installClassicReadOnlyGuard(api), [])
  const blockAction = (e: SyntheticEvent) => {
    const t = targetOf(e)
    const control = controlOf(t)
    if (isSafe(control)) return
    if ((control && !control.matches(TEXT_INPUT)) || inSortable(t)) block(e)
  }
  const blockTyping = (e: SyntheticEvent) => {
    if (isText(targetOf(e))) block(e)
  }
  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3'>
      <div
        role='note'
        className='flex shrink-0 items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
      >
        <Lock className='h-3.5 w-3.5 shrink-0' />
        <span className='min-w-0 flex-1'>
          {CLASSIC_READ_ONLY_MESSAGE}. This is the old Layouts tab, kept for comparison; nothing
          here can be changed.
        </span>
        <button
          type='button'
          onClick={onOpenNew}
          className='inline-flex h-7 shrink-0 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90'
        >
          Open in the new editor
        </button>
      </div>
      <div
        data-classic-read-only=''
        className='flex min-h-0 flex-1 flex-col [&_button:not([aria-haspopup]):not([aria-expanded]):not([data-classic-nav]):not([role=tab])]:cursor-not-allowed [&_button:not([aria-haspopup]):not([aria-expanded]):not([data-classic-nav]):not([role=tab])]:opacity-60 [&_input]:caret-transparent [&_textarea]:caret-transparent'
        onClickCapture={(e) => {
          if (classicBlocksClick(targetOf(e))) block(e)
        }}
        onPointerDownCapture={blockAction}
        onMouseDownCapture={blockAction}
        onKeyDownCapture={(e) => {
          const t = targetOf(e)
          if (READ_KEYS.has(e.key) && !inSortable(t)) return
          if (isText(t)) return block(e)
          // Space/Enter on a sortable starts a keyboard drag.
          if (inSortable(t) && !isSafe(controlOf(t))) block(e)
        }}
        onBeforeInputCapture={blockTyping}
        onInputCapture={blockTyping}
        onChangeCapture={(e) => {
          if (controlOf(targetOf(e))) block(e)
        }}
        onPasteCapture={blockTyping}
        onCutCapture={blockTyping}
        onDropCapture={block}
        onDragStartCapture={block}
        onSubmitCapture={block}
      >
        {children}
      </div>
    </div>
  )
}
