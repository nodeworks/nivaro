import { useEffect, useRef } from 'react'
import type { EntryConfig } from '../../../lib/entry-config'
import { enterIsTaken, entrySequence, FOCUSABLE, firstEmptyRequired, stepField } from './entry-keys'

/**
 * Per-form keyboard behaviour from the layout's entry config:
 *  - focus_first: when the form opens, the cursor goes to the first empty required field (#2707)
 *  - enter_next: Enter in a field moves to the next one; Ctrl / ⌘ + Enter saves (#2707)
 *  - tab_order: Tab and Shift+Tab walk the fields in the order the layout sets (#2708)
 * One document listener scoped to this form's fields (data-field-collection), so it
 * needs no wrapper element and costs nothing when none of the three is on.
 */

const fieldEls = (collection: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-field]')).filter(
    (el) =>
      el.getAttribute('data-field-collection') === collection &&
      // Fields of a nested form (a record shown inside a field) are not this form's.
      el.parentElement?.closest('[data-field]') == null &&
      el.getClientRects().length > 0
  )

// Field chrome (the ⋯ menu, a default's undo, Repeat last, AI fill) is never where entry starts.
const CHROME =
  '[data-field-menu-trigger], [data-personal-default-undo], [data-repeat-last], [data-ai-fill]'

const focusablesIn = (el: HTMLElement): HTMLElement[] =>
  Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (n) => n.getClientRects().length > 0 && n.tabIndex !== -1 && !n.matches(CHROME)
  )

function focusField(el: HTMLElement | undefined, last = false): boolean {
  if (!el) return false
  const targets = focusablesIn(el)
  const t = last ? targets[targets.length - 1] : targets[0]
  if (!t) return false
  t.focus()
  if (t instanceof HTMLInputElement && t.type === 'text') t.select?.()
  return true
}

export interface EntryKeyboardArgs {
  collection: string
  config: EntryConfig
  /** Off while the editor canvas, a read view or a closed form is shown. */
  enabled: boolean
  /** The form has its record (a new one is ready at once). */
  ready: boolean
  recordKey: string
  required: ReadonlySet<string>
  draft: Record<string, unknown>
  save: () => void
}

export function useEntryKeyboard(args: EntryKeyboardArgs) {
  const { collection, config, enabled, ready, recordKey } = args
  const live = useRef(args)
  live.current = args

  // Focus the first empty required field, once per record this form shows.
  const focusedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || !ready || !config.focus_first) return
    if (focusedFor.current === recordKey) return
    let tries = 0
    const timer = window.setInterval(() => {
      tries++
      const a = live.current
      const els = fieldEls(collection)
      if (els.length > 0) {
        window.clearInterval(timer)
        focusedFor.current = recordKey
        // Something already holds focus (a search box, the person typing): leave it.
        const active = document.activeElement
        if (active && active !== document.body && active.closest('input, textarea, select')) return
        const order = els.map((e) => e.getAttribute('data-field') as string)
        const key = firstEmptyRequired(order, a.required, a.draft)
        if (key) focusField(els[order.indexOf(key)])
      } else if (tries > 12) window.clearInterval(timer)
    }, 150)
    return () => window.clearInterval(timer)
  }, [enabled, ready, config.focus_first, recordKey, collection])

  const wantKeys = enabled && (config.enter_next === true || !!config.tab_order?.length)
  useEffect(() => {
    if (!wantKeys) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      const target = e.target as HTMLElement | null
      const wrapper = target?.closest<HTMLElement>('[data-field]')
      if (!target || !wrapper || wrapper.getAttribute('data-field-collection') !== collection)
        return
      if (wrapper.parentElement?.closest('[data-field]')) return
      const cfg = live.current.config
      const els = fieldEls(collection)
      const order = els.map((x) => x.getAttribute('data-field') as string)
      const seq = entrySequence(order, cfg.tab_order)
      const here = wrapper.getAttribute('data-field') as string

      if (e.key === 'Enter' && cfg.enter_next) {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          live.current.save()
          return
        }
        if (e.shiftKey || e.altKey || enterIsTaken(target)) return
        const next = stepField(seq, here, 1)
        const nextEl = next ? els[order.indexOf(next)] : undefined
        if (nextEl && focusField(nextEl)) e.preventDefault()
        return
      }

      if (e.key === 'Tab' && cfg.tab_order?.length && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const own = focusablesIn(wrapper)
        const at = own.indexOf(target)
        // Only the last (first, going back) control of a field leaves it: a field
        // with two inputs keeps its own order inside.
        if (at >= 0 && (e.shiftKey ? at > 0 : at < own.length - 1)) return
        const next = stepField(seq, here, e.shiftKey ? -1 : 1)
        const nextEl = next ? els[order.indexOf(next)] : undefined
        if (nextEl && focusField(nextEl, e.shiftKey)) e.preventDefault()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [wantKeys, collection])
}
