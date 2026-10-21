import {
  ChevronRight,
  Columns3,
  EyeOff,
  Gauge,
  Info,
  LayoutPanelTop,
  ListOrdered,
  PanelTop,
  Rows3,
  Text,
  TextCursorInput,
  X
} from 'lucide-react'
import { type DragEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { type DesignTarget, type SelectOptions, targetKey } from '../design-context'
import type { DropSide } from '../dnd/collision'
import { dropLabel, orderAfterDrop } from '../dnd/order'
import type { ApplyOptions } from '../useLayoutDraft'
import { KIND_WORDS, type NavKind, type NavNode, walk } from './tree'

// The outline (#2621): steps, tabs, sections and fields as a tree beside the
// canvas. A click selects on the canvas (and opens the step or tab it sits
// in); a canvas selection highlights its row. Rows drag to reorder with the
// canvas's own drop rules (orderAfterDrop): one drop, one move / group_move,
// one undo step.

const KIND_ICON: Record<NavKind, typeof Rows3> = {
  header: PanelTop,
  step: ListOrdered,
  tab: PanelTop,
  'steps-holder': Columns3,
  'tabs-holder': Columns3,
  section: Rows3,
  text: Text,
  info: Info,
  ungrouped: Rows3,
  panel: LayoutPanelTop,
  widget: Gauge,
  field: TextCursorInput
}

interface Drop {
  id: string
  side: DropSide
  /** A field dropped on a section row lands first in it: the row lights up. */
  into: boolean
  ops: LayoutOp[]
}

const isItem = (t: DesignTarget) =>
  t.kind === 'field' || (t.kind === 'slot' && t.group_key !== null)

/** Where a moved target is after its drop (a field that changed section has a new key). */
function movedTarget(active: DesignTarget, ops: LayoutOp[]): DesignTarget {
  const op = ops[0]
  if (op?.op === 'move' && (active.kind === 'field' || active.kind === 'slot'))
    return { ...active, group_key: op.to_group_key }
  return active
}

export function OutlinePanel({
  bundle,
  nodes,
  selection,
  onPick,
  onMoved,
  apply,
  onClose
}: {
  bundle: LayoutBundle
  nodes: NavNode[]
  selection: DesignTarget[]
  /** A row was clicked: select it on the canvas and bring it into view. */
  onPick: (t: DesignTarget, opts?: SelectOptions) => void
  /** A drop moved this; it stays selected. */
  onMoved: (t: DesignTarget) => void
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  onClose: () => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [drag, setDrag] = useState<DesignTarget | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const treeRef = useRef<HTMLDivElement | null>(null)
  const selected = useMemo(() => new Set(selection.map(targetKey)), [selection])
  const lastSelected = selection.length > 0 ? targetKey(selection[selection.length - 1]) : null
  const all = useMemo(() => walk(nodes), [nodes])

  // A canvas selection inside a folded branch opens it, and its row scrolls into view.
  useEffect(() => {
    if (!lastSelected) return
    const entry = all.find((e) => e.node.id === lastSelected)
    if (!entry) return
    setCollapsed((cur) => {
      if (!entry.path.some((p) => cur.has(p.id))) return cur
      const next = new Set(cur)
      for (const p of entry.path) next.delete(p.id)
      return next
    })
    requestAnimationFrame(() =>
      treeRef.current
        ?.querySelector<HTMLElement>(`[data-outline-row="${CSS.escape(lastSelected)}"]`)
        ?.scrollIntoView?.({ block: 'nearest' })
    )
  }, [lastSelected, all])

  // Rows on screen, in order (folded branches skipped), for the arrow keys.
  const visible = useMemo(() => {
    const out: Array<{ node: NavNode; depth: number }> = []
    const add = (list: NavNode[], depth: number) => {
      for (const n of list) {
        out.push({ node: n, depth })
        if (n.children.length > 0 && !collapsed.has(n.id)) add(n.children, depth + 1)
      }
    }
    add(nodes, 0)
    return out
  }, [nodes, collapsed])

  const anyVisibleSelected = visible.some((v) => selected.has(v.node.id))

  const toggle = (id: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const focusRow = (i: number) =>
    treeRef.current?.querySelectorAll<HTMLElement>('[data-outline-row]')[i]?.focus()

  const onKey = (e: KeyboardEvent, i: number, n: NavNode) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      focusRow(Math.max(0, Math.min(visible.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'ArrowRight' && n.children.length > 0 && collapsed.has(n.id)) {
      e.preventDefault()
      toggle(n.id)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (n.children.length > 0 && !collapsed.has(n.id)) toggle(n.id)
      else {
        const parent = all.find((x) => x.node.id === n.id)?.path.at(-1)
        const at = parent ? visible.findIndex((v) => v.node.id === parent.id) : -1
        if (at >= 0) focusRow(at)
      }
    }
  }

  const canDrag = (n: NavNode) => !!n.target && !n.inherited
  // The order a section, tab or page panel moves in (undefined: a field or tile).
  const parentOf = (t: DesignTarget): string | null | undefined =>
    t.kind === 'group'
      ? (bundle.groups.find((g) => g.key === t.key)?.parent_key ?? null)
      : t.kind === 'slot' && t.group_key === null
        ? null
        : undefined

  const dropAt = (e: DragEvent, n: NavNode): Drop | null => {
    if (!drag || !n.target || n.inherited) return null
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const into = isItem(drag) && n.target.kind === 'group'
    // A section, tab or page panel lands only beside its own siblings: never on
    // a field row (or a tab) standing in for the section around it.
    if (!isItem(drag) && drag.kind !== 'header' && parentOf(n.target) !== parentOf(drag))
      return null
    const side: DropSide = into || e.clientY < r.top + r.height / 2 ? 'before' : 'after'
    const ops = orderAfterDrop(bundle, drag, n.target, side)
    return ops.length > 0 ? { id: n.id, side, into, ops } : null
  }

  const endDrag = () => {
    setDrag(null)
    setDrop(null)
  }

  return (
    <div data-editor-outline='' className='flex h-full min-h-0 flex-col'>
      <div className='flex shrink-0 items-center justify-between border-b border-slate-200 py-1.5 pl-3 pr-1.5 dark:border-border'>
        <p className='text-[12px] font-semibold text-slate-700 dark:text-foreground'>Outline</p>
        <button
          type='button'
          aria-label='Close the outline'
          data-tip='Close the outline'
          onClick={onClose}
          className='inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      <div
        ref={treeRef}
        role='tree'
        aria-label='Form outline'
        aria-multiselectable='true'
        className='min-h-0 flex-1 overflow-y-auto px-1 py-1'
      >
        {visible.length === 0 && (
          <p className='px-2 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Nothing on this form yet.
          </p>
        )}
        {visible.map(({ node: n, depth }, i) => {
          const Icon = KIND_ICON[n.kind]
          const open = !collapsed.has(n.id)
          const on = selected.has(n.id)
          const line = drop?.id === n.id && !drop.into ? drop.side : null
          return (
            <div
              key={n.id}
              role='treeitem'
              tabIndex={on || (i === 0 && !anyVisibleSelected) ? 0 : -1}
              aria-level={depth + 1}
              aria-selected={on}
              aria-expanded={n.children.length > 0 ? open : undefined}
              data-outline-row={n.id}
              data-outline-kind={n.kind}
              draggable={canDrag(n)}
              onDragStart={(e) => {
                if (!n.target || !canDrag(n)) return
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', n.label)
                setDrag(n.target)
              }}
              onDragOver={(e) => {
                const d = dropAt(e, n)
                if (!d) {
                  if (drop?.id === n.id) setDrop(null)
                  return
                }
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (drop?.id !== d.id || drop.side !== d.side || drop.into !== d.into) setDrop(d)
              }}
              onDragLeave={(e) => {
                if (drop?.id === n.id && !e.currentTarget.contains(e.relatedTarget as Node))
                  setDrop(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                const d = drop?.id === n.id ? drop : dropAt(e, n)
                const active = drag
                endDrag()
                if (!d || !active) return
                apply(d.ops, { label: dropLabel(bundle, active) })
                onMoved(movedTarget(active, d.ops))
              }}
              onDragEnd={endDrag}
              onClick={(e) => {
                if (!n.target) return toggle(n.id)
                onPick(n.target, { additive: e.shiftKey || e.metaKey || e.ctrlKey })
              }}
              onKeyDown={(e) => {
                onKey(e, i, n)
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  if (n.target) onPick(n.target)
                  else toggle(n.id)
                }
              }}
              style={{ paddingLeft: 4 + depth * 14 }}
              className={cn(
                'group/row relative flex h-7 cursor-pointer select-none items-center gap-1 rounded-md pr-2 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
                on
                  ? 'bg-accent text-slate-900 dark:text-foreground'
                  : 'text-slate-700 hover:bg-muted dark:text-foreground',
                drop?.id === n.id && drop.into && 'ring-2 ring-inset ring-nvr-cyan',
                drag && targetKey(drag) === n.id && 'opacity-50',
                n.inherited && 'text-slate-500 dark:text-muted-foreground'
              )}
            >
              {line && (
                <span
                  aria-hidden='true'
                  data-outline-drop={line}
                  className={cn(
                    'pointer-events-none absolute left-1 right-1 h-0.5 rounded-full bg-nvr-cyan',
                    line === 'before' ? '-top-px' : '-bottom-px'
                  )}
                />
              )}
              {n.children.length > 0 ? (
                <button
                  type='button'
                  tabIndex={-1}
                  aria-label={open ? `Fold ${n.label}` : `Unfold ${n.label}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle(n.id)
                  }}
                  className='inline-flex h-5 w-4 shrink-0 items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-foreground'
                >
                  <ChevronRight
                    className={cn('h-3 w-3 transition-transform', open && 'rotate-90')}
                  />
                </button>
              ) : (
                <span className='w-4 shrink-0' />
              )}
              <Icon
                aria-hidden='true'
                className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-muted-foreground'
              />
              <span
                data-tip={`${KIND_WORDS[n.kind]} · ${n.key}`}
                className={cn('min-w-0 flex-1 truncate', n.kind !== 'field' && 'font-medium')}
              >
                {n.label}
              </span>
              {n.hidden && (
                <EyeOff
                  aria-label='Hidden'
                  className='h-3 w-3 shrink-0 text-slate-400 dark:text-muted-foreground'
                />
              )}
              {n.inherited && (
                <span className='shrink-0 text-[10.5px] text-violet-600 dark:text-violet-300'>
                  inherited
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
