import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LiveBatch } from '../../lib/live'
import type { ActiveLayoutData, CMSField } from './types'

/**
 * Smooth layout switch (realtime round 8, item 18).
 *
 * Which form a record gets can depend on the record (a form's record rules read its fields).
 * When a move or a field change makes a different form apply to the record on screen, the page
 * changes to it in place instead of waiting for a reload:
 *
 *   - the new form's field list is read first, so the page never flashes empty in between;
 *   - the field at the top of the view stays where it was (scroll anchor), and the field being
 *     typed in keeps focus when the new form still has it;
 *   - unsaved values carry over for fields the new form shows and lets the person edit; a value
 *     for a field the new form hides or makes read-only is taken out of the save and kept in a
 *     chip the person can copy from (or put back if a later form shows the field again) — never
 *     carried silently into a field they can no longer see or change;
 *   - a quiet note says "Form updated for <step>".
 *
 * The server decides the form exactly as on open (pickBestLayout with the caller's
 * ResolveContext, GET /collection-layouts/active); this only re-asks — when the step changes or
 * a field one of the forms' record rules reads changes (`rule_fields` on the answer).
 */

/** Could this live batch change which form applies? (pure; exported for tests) */
export function layoutMayChange(
  batch: Pick<LiveBatch, 'changedFields' | 'aspectsOnly' | 'deleted'>,
  ruleFields: readonly string[] | null | undefined
): boolean {
  if (batch.deleted) return false
  if (!ruleFields || ruleFields.length === 0) return false
  if (batch.changedFields === null) return !batch.aspectsOnly
  return batch.changedFields.some((f) => ruleFields.includes(f))
}

export type FieldStatus = 'editable' | 'readonly' | 'hidden' | 'absent'

/** How a form's field list treats one field (pure; exported for tests). */
export function fieldStatus(fields: CMSField[] | null | undefined, key: string): FieldStatus {
  const f = (fields ?? []).find((x) => x.field === key)
  if (!f) return 'absent'
  if (f.hidden) return 'hidden'
  if (f.readonly) return 'readonly'
  return 'editable'
}

const same = (a: unknown, b: unknown) => {
  if (a === b) return true
  if ((a == null || a === '') && (b == null || b === '')) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * Which unsaved values stay in the form and which are held back for the new form (pure;
 * exported for tests). Unsaved = the draft differs from what is saved.
 */
export function splitUnsaved(
  draft: Record<string, unknown>,
  saved: Record<string, unknown>,
  newFields: CMSField[] | null | undefined
): { keep: string[]; held: Array<{ field: string; status: FieldStatus }> } {
  const keep: string[] = []
  const held: Array<{ field: string; status: FieldStatus }> = []
  for (const k of Object.keys(draft)) {
    if (k.startsWith('$') || k.startsWith('__')) continue
    if (same(draft[k], saved[k])) continue
    const status = fieldStatus(newFields, k)
    if (status === 'editable') keep.push(k)
    else held.push({ field: k, status })
  }
  return { keep, held }
}

/** "Form updated for Finance review" / "Form updated" (pure; exported for tests). */
export function formUpdatedText(stepLabel: string | null | undefined): string {
  const step = stepLabel?.trim()
  return step ? `Form updated for ${step}` : 'Form updated'
}

// ── Scroll anchor + focus ────────────────────────────────────────────────────

export interface FormAnchor {
  /** Fields at the top of the view, top-most first, with their distance from the view's top. */
  fields: Array<{ key: string; top: number }>
  focused: string | null
  scroller: HTMLElement | null
}

function scrollParent(el: Element | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node && node !== document.body) {
    const style = getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? null
}

function fieldEl(key: string): HTMLElement | null {
  try {
    return document.querySelector<HTMLElement>(`[data-field="${CSS.escape(key)}"]`)
  } catch {
    return null
  }
}

/** Where the person is: the fields at the top of the view and the one with focus. */
export function captureFormAnchor(): FormAnchor | null {
  if (typeof document === 'undefined') return null
  const all = [...document.querySelectorAll<HTMLElement>('[data-field]')]
  if (all.length === 0) return null
  const scroller = scrollParent(all[0])
  const viewTop =
    scroller && scroller !== document.scrollingElement ? scroller.getBoundingClientRect().top : 0
  const fields: FormAnchor['fields'] = []
  for (const el of all) {
    const r = el.getBoundingClientRect()
    if (r.height === 0 || r.bottom <= viewTop) continue
    const key = el.getAttribute('data-field')
    if (!key || fields.some((f) => f.key === key)) continue
    fields.push({ key, top: r.top - viewTop })
    if (fields.length >= 6) break
  }
  const active = document.activeElement as HTMLElement | null
  const focused = active?.closest?.('[data-field]')?.getAttribute('data-field') ?? null
  return { fields, focused, scroller }
}

/** Put the view back on the same field and give focus back where the field still exists. */
export function restoreFormAnchor(anchor: FormAnchor | null): boolean {
  if (!anchor || typeof document === 'undefined') return false
  const scroller = anchor.scroller
  const viewTop =
    scroller && scroller !== document.scrollingElement ? scroller.getBoundingClientRect().top : 0
  let placed = false
  for (const f of anchor.fields) {
    const el = fieldEl(f.key)
    if (!el) continue
    const delta = el.getBoundingClientRect().top - viewTop - f.top
    if (Math.abs(delta) >= 1) {
      if (scroller) scroller.scrollTop += delta
      else window.scrollBy(0, delta)
    }
    placed = true
    break
  }
  if (anchor.focused) {
    const el = fieldEl(anchor.focused)
    if (el && !el.contains(document.activeElement)) {
      const target = el.querySelector<HTMLElement>(
        'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), [role="combobox"], [contenteditable="true"]'
      )
      target?.focus({ preventScroll: true })
    }
  }
  return placed
}

// ── The hook ─────────────────────────────────────────────────────────────────

export interface LayoutSwitch {
  from: ActiveLayoutData | null
  to: ActiveLayoutData
  n: number
}

/**
 * The form the page shows. The first answer shows at once; a later answer naming a DIFFERENT
 * form waits for `prepare` (the new field list) and then switches, keeping the view's anchor
 * and focus. A refreshed answer for the same form passes straight through.
 */
export function useSmoothLayout(
  fetched: ActiveLayoutData | null | undefined,
  opts: {
    enabled: boolean
    prepare: (layoutId: number) => Promise<CMSField[] | null>
    onSwitch: (sw: LayoutSwitch, fields: CMSField[] | null) => void
  }
): { shown: ActiveLayoutData | null | undefined; last: LayoutSwitch | null } {
  const [shown, setShown] = useState<ActiveLayoutData | null | undefined>(fetched)
  const [last, setLast] = useState<LayoutSwitch | null>(null)
  const shownRef = useRef(shown)
  shownRef.current = shown
  const optsRef = useRef(opts)
  optsRef.current = opts
  const anchorRef = useRef<FormAnchor | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const cur = shownRef.current
    const nextId = fetched?.layout?.id ?? null
    const curId = cur?.layout?.id ?? null
    if (
      !optsRef.current.enabled ||
      cur === undefined ||
      fetched === undefined ||
      nextId === curId
    ) {
      if (fetched !== cur) setShown(fetched)
      return
    }
    if (fetched === null || nextId == null) {
      // The form went away (no form applies any more): show the automatic one.
      setShown(fetched)
      return
    }
    let stop = false
    const n = ++seq.current
    void optsRef.current
      .prepare(nextId)
      .catch(() => null)
      .then((fields) => {
        if (stop || n !== seq.current) return
        anchorRef.current = captureFormAnchor()
        const sw: LayoutSwitch = { from: cur ?? null, to: fetched, n }
        optsRef.current.onSwitch(sw, fields)
        setShown(fetched)
        setLast(sw)
      })
    return () => {
      stop = true
    }
  }, [fetched])

  // Until a different form is ready, the page keeps the one it shows; everything else (the
  // first answer, a refreshed answer for the same form, no form at all) passes straight
  // through, so the first paint never waits a render.
  const passThrough =
    fetched === undefined ||
    fetched === null ||
    shown === undefined ||
    !opts.enabled ||
    (fetched?.layout?.id ?? null) === (shown?.layout?.id ?? null)
  const value = passThrough ? fetched : shown

  // After the new form painted: back to the same field, focus where it still exists.
  const shownId = value?.layout?.id ?? null
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the shown form changed
  useLayoutEffect(() => {
    const a = anchorRef.current
    if (!a) return
    anchorRef.current = null
    if (!restoreFormAnchor(a)) {
      // Sections can mount a frame later; one more try.
      const raf = requestAnimationFrame(() => restoreFormAnchor(a))
      return () => cancelAnimationFrame(raf)
    }
  }, [shownId])

  return { shown: value, last }
}
