import { LayoutPanelTop } from 'lucide-react'
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { listLayoutSlots } from '../../lib/layout-slots'
import { titleCase } from '../../lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { type AddFieldRow, BUILT_IN_SLOTS, SLOT_HINTS, typeWord } from './AddPanel'
import { type Gap, gapSpot, placeOp, sectionOp, slotSpot } from './add-target'
import { sectionLabel } from './canvas-diff'
import type { DesignTarget } from './design-context'
import { isTyping } from './is-typing'
import { parseTargetKey } from './StructureMenu'
import { registerShortcut } from './shortcuts'
import { slotName } from './slot-names'
import type { ApplyOptions } from './useLayoutDraft'

// Slash-insert (#3181): with the pointer over a gap on the canvas — between
// two fields, at the end of a section — or a field focused, typing / opens a
// small search right there: a field, a panel or a new section goes in that
// gap as one `place` (or `group_create`) op, one undo step, and is selected.

registerShortcut({
  id: 'slash-insert',
  area: 'Editing',
  keys: [['/']],
  label: 'Add a field, panel or section in the gap under the pointer (or after the focused field)'
})

type Rect = { left: number; top: number; width: number; height: number }

export interface CanvasGap {
  gap: Gap
  /** The node the gap sits beside: what a new section or panel goes after. */
  near: DesignTarget
  /** Where the gap is on screen: the line drawn while the search is open. */
  line: Rect
  /** "in Shipping", "between sections". */
  where: string
}

const NODE = '[data-design-target]'

function nodeTarget(el: Element): DesignTarget | null {
  return parseTargetKey(el.getAttribute('data-design-target'))
}

/** A node fills its row when it is most of its section's width: gaps are above and below it. */
function fillsRow(el: Element, rect: DOMRect): boolean {
  const holder = el.parentElement?.closest(NODE) ?? el.parentElement
  const w = holder?.getBoundingClientRect().width ?? rect.width
  return w <= 0 || rect.width >= w * 0.6
}

function lineBeside(rect: DOMRect, before: boolean, wide: boolean): Rect {
  if (wide)
    return {
      left: rect.left,
      top: before ? rect.top - 2 : rect.bottom,
      width: rect.width,
      height: 2
    }
  return { left: before ? rect.left - 2 : rect.right, top: rect.top, width: 2, height: rect.height }
}

/** The gap at a point on the canvas, from the nodes under it (null: not over the form). */
export function gapAtPoint(
  bundle: LayoutBundle,
  root: HTMLElement,
  x: number,
  y: number
): CanvasGap | null {
  const hit = document.elementFromPoint?.(x, y) ?? null
  if (!hit || !root.contains(hit) || !hit.closest('[data-design-canvas]')) return null
  const node = hit.closest(NODE)
  if (!node) return null
  const t = nodeTarget(node)
  if (!t) return null
  if (t.kind !== 'group') {
    const rect = node.getBoundingClientRect()
    const wide = fillsRow(node, rect)
    const before = wide ? y < rect.top + rect.height / 2 : x < rect.left + rect.width / 2
    return gapBeside(bundle, t, before, lineBeside(rect, before, wide))
  }
  // Over a section but between its fields: the gap after the last field before the point.
  const key = t.key
  const fields = Array.from(node.querySelectorAll(NODE)).filter((el) => {
    const ft = nodeTarget(el)
    return (
      ft &&
      ft.kind !== 'group' &&
      ft.kind !== 'header' &&
      (ft.group_key ?? UNGROUPED_KEY) === key &&
      el.parentElement?.closest(NODE) === node
    )
  })
  let after: Element | null = null
  for (const el of fields) {
    const r = el.getBoundingClientRect()
    if (r.bottom <= y || (r.top <= y && r.right <= x)) after = el
  }
  if (after) {
    const r = after.getBoundingClientRect()
    const wide = fillsRow(after, r)
    return gapBeside(bundle, nodeTarget(after) as DesignTarget, false, lineBeside(r, false, wide))
  }
  if (fields.length > 0) {
    const r = fields[0].getBoundingClientRect()
    const wide = fillsRow(fields[0], r)
    return gapBeside(bundle, nodeTarget(fields[0]) as DesignTarget, true, lineBeside(r, true, wide))
  }
  const r = node.getBoundingClientRect()
  return gapBeside(bundle, t, false, {
    left: r.left + 12,
    top: r.bottom - 14,
    width: Math.max(0, r.width - 24),
    height: 2
  })
}

export function gapBeside(
  bundle: LayoutBundle,
  t: DesignTarget,
  before: boolean,
  line: Rect
): CanvasGap | null {
  const gap = gapSpot(bundle, t, before)
  if (!gap) return null
  const where = gap.top
    ? 'between the form’s sections'
    : gap.group_key === HEADER_GROUP_KEY
      ? 'in the header strip'
      : `in ${sectionLabel(bundle.groups, gap.group_key)}`
  return { gap, near: t, line, where }
}

const menuOpen = () =>
  !!document.querySelector('[data-radix-popper-content-wrapper], [role="menu"]')

export interface SlashInsertProps {
  bundle: LayoutBundle | null
  fields: AddFieldRow[]
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  onSelect: (t: DesignTarget) => void
  /** The editor's body: the canvas inside it answers to /. */
  rootRef: RefObject<HTMLElement | null>
  /** Off while the canvas is not shown (table and matrix views). */
  enabled: boolean
}

interface Choice {
  id: string
  kind: 'field' | 'slot' | 'section'
  title: string
  sub: string
  value: string
}

export function SlashInsert({
  bundle,
  fields,
  apply,
  onSelect,
  rootRef,
  enabled
}: SlashInsertProps) {
  const [open, setOpen] = useState<CanvasGap | null>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const live = useRef({ bundle, enabled })
  live.current = { bundle, enabled }

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      const root = rootRef.current
      const { bundle: b, enabled: on } = live.current
      if (!on || !b || !root?.isConnected || isTyping(e.target) || menuOpen()) return
      let found: CanvasGap | null = null
      const p = pointer.current
      if (p) found = gapAtPoint(b, root, p.x, p.y)
      if (!found) {
        // From the keyboard: the gap after the focused field (the end of a focused section).
        const el = (document.activeElement as Element | null)?.closest?.(NODE) ?? null
        const t =
          el && root.contains(el) && el.closest('[data-design-canvas]') ? nodeTarget(el) : null
        if (el && t) {
          const r = el.getBoundingClientRect()
          found = gapBeside(b, t, false, lineBeside(r, false, true))
        }
      }
      if (!found) return
      e.preventDefault()
      setOpen(found)
    }
    document.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointermove', onMove)
      window.removeEventListener('keydown', onKey)
    }
  }, [rootRef])

  const choices = useMemo<Choice[]>(() => {
    if (!open || !bundle) return []
    const out: Choice[] = []
    const gap = open.gap
    const header = !gap.top && gap.group_key === HEADER_GROUP_KEY
    if (!gap.top) {
      const zone = new Set(
        bundle.placements.filter((p) => p.group_key === gap.group_key).map((p) => p.field)
      )
      const anywhere = new Set(bundle.placements.map((p) => p.field))
      const rows = fields
        .filter((f) => f.field && !f.field.startsWith('__') && !zone.has(f.field))
        .map((f) => ({ f, title: f.label || titleCase(f.field) }))
        .sort(
          (a, b) =>
            Number(anywhere.has(a.f.field)) - Number(anywhere.has(b.f.field)) ||
            a.title.localeCompare(b.title)
        )
      for (const { f, title } of rows)
        out.push({
          id: f.field,
          kind: 'field',
          title,
          sub: [f.field, typeWord(f), anywhere.has(f.field) ? 'also elsewhere on the form' : null]
            .filter(Boolean)
            .join(' · '),
          value: `${title} ${f.field}`
        })
    }
    const slots = [...BUILT_IN_SLOTS, ...listLayoutSlots().map((k) => `__ext_${k}__`)].filter(
      (s) => s !== '__subtitle__' && (header ? s === '__owners__' : true)
    )
    const placed = new Set(bundle.placements.map((p) => p.field))
    for (const s of slots)
      if (!placed.has(s))
        out.push({
          id: s,
          kind: 'slot',
          title: slotName(s),
          sub: SLOT_HINTS[s] ?? 'Extension panel',
          value: `${slotName(s)} panel ${SLOT_HINTS[s] ?? ''}`
        })
    if (!header) {
      const sec = sectionOp(bundle, open.near.kind === 'header' ? null : open.near)
      if (sec.op === 'group_create') {
        const word = sec.label.replace(/^New /, '')
        out.push({
          id: '__section__',
          kind: 'section',
          title: `New ${word}`,
          sub: `A new ${word} after this one`,
          value: `new ${word} section tab step layout`
        })
      }
    }
    return out
  }, [open, bundle, fields])

  const pick = useCallback(
    (c: Choice) => {
      const at = open
      setOpen(null)
      if (!at || !bundle) return
      const gap = at.gap
      if (c.kind === 'section') {
        const op = sectionOp(bundle, at.near.kind === 'header' ? null : at.near)
        apply([op], {
          label: `Add ${op.op === 'group_create' ? op.label.toLowerCase() : 'section'}`
        })
        if (op.op === 'group_create') onSelect({ kind: 'group', key: op.key })
        return
      }
      const canvas = isCanvasSlot({ field: c.id, group_key: null })
      const spot =
        c.kind === 'slot' && canvas
          ? gap.top
            ? { group_key: null, index: gap.index }
            : slotSpot(bundle, at.near)
          : gap.top
            ? null
            : { group_key: gap.group_key, index: gap.index }
      if (!spot) return
      apply([placeOp(c.id, spot)], { label: `Add ${c.title}` })
      onSelect(
        spot.group_key === HEADER_GROUP_KEY
          ? { kind: 'header', field: c.id }
          : { kind: c.kind === 'slot' ? 'slot' : 'field', field: c.id, group_key: spot.group_key }
      )
    },
    [open, bundle, apply, onSelect]
  )

  const anchorRef = useMemo(() => {
    const l = open?.line
    return {
      current: {
        getBoundingClientRect: () =>
          l ? new DOMRect(l.left + l.width / 2, l.top + l.height, 0, 0) : new DOMRect()
      }
    }
  }, [open])

  if (!open || !bundle) return null
  const root = rootRef.current
  const lineHost = (root?.closest('[role="dialog"]') as HTMLElement | null) ?? document.body
  const fieldChoices = choices.filter((c) => c.kind === 'field')
  const slotChoices = choices.filter((c) => c.kind === 'slot')
  const sectionChoice = choices.find((c) => c.kind === 'section')
  return (
    <>
      {createPortal(
        <div
          aria-hidden='true'
          data-slash-gap=''
          className='pointer-events-none fixed z-[100] rounded-full bg-nvr-cyan'
          style={{
            left: open.line.left,
            top: open.line.top,
            width: Math.max(open.line.width, 2),
            height: Math.max(open.line.height, 2)
          }}
        />,
        lineHost
      )}
      <Popover open onOpenChange={(o) => !o && setOpen(null)}>
        <PopoverAnchor virtualRef={anchorRef} />
        <PopoverContent
          align='start'
          sideOffset={6}
          className='w-[300px] p-0'
          data-slash-insert=''
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <Command>
            <CommandInput placeholder={`Add ${open.where}…`} aria-label={`Add ${open.where}`} />
            <CommandList className='max-h-[min(50vh,320px)] overscroll-contain'>
              <CommandEmpty>Nothing matches.</CommandEmpty>
              {sectionChoice && (
                <CommandGroup heading='Layout'>
                  <ChoiceRow c={sectionChoice} onPick={pick} />
                </CommandGroup>
              )}
              {fieldChoices.length > 0 && (
                <CommandGroup heading='Fields'>
                  {fieldChoices.map((c) => (
                    <ChoiceRow key={c.id} c={c} onPick={pick} />
                  ))}
                </CommandGroup>
              )}
              {slotChoices.length > 0 && (
                <CommandGroup heading='Panels'>
                  {slotChoices.map((c) => (
                    <ChoiceRow key={c.id} c={c} onPick={pick} />
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  )
}

function ChoiceRow({ c, onPick }: { c: Choice; onPick: (c: Choice) => void }) {
  return (
    <CommandItem
      value={c.value}
      onSelect={() => onPick(c)}
      data-slash-choice={c.id}
      className='flex items-center gap-2'
    >
      <span className='flex min-w-0 flex-1 flex-col'>
        <span className='truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
          {c.title}
        </span>
        <span className='truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {c.sub}
        </span>
      </span>
      {c.kind === 'section' && (
        <LayoutPanelTop className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-muted-foreground' />
      )}
    </CommandItem>
  )
}
