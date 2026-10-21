import { EyeOff, Lock } from 'lucide-react'
import {
  type CSSProperties,
  cloneElement,
  isValidElement,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react'
import { cn } from '../../lib/utils'
import type { DesignMark, DesignTarget, LayoutDesign } from './design-context'
import { isSelectedIn, targetKey, useLayoutDesign } from './design-context'
import { NO_DND, useDesignDndNode, useDesignDropBody } from './dnd/node'

type ChildProps = {
  className?: string
  style?: CSSProperties
  ref?: Ref<unknown>
  children?: ReactNode
}
type Props = Record<string, unknown>

const assignRef = (ref: unknown, el: unknown) => {
  if (typeof ref === 'function') ref(el)
  else if (ref && typeof ref === 'object') (ref as { current: unknown }).current = el
}

/**
 * Merge prop sets left to right: classes join, styles merge, refs and
 * handlers (`on…`) both run — so the dnd props, the shell's own and the
 * child's own (asChild) never override one another.
 */
function mergeProps(...sets: Props[]): Props {
  const out: Props = {}
  for (const set of sets) {
    for (const [k, v] of Object.entries(set)) {
      const cur = out[k]
      if (v === undefined) continue
      if (cur === undefined) out[k] = v
      else if (k === 'className') out[k] = `${cur} ${v}`
      else if (k === 'style') out[k] = { ...(cur as object), ...(v as object) }
      else if (k === 'ref')
        out[k] = (el: unknown) => {
          assignRef(cur, el)
          assignRef(v, el)
        }
      else if (/^on[A-Z]/.test(k) && typeof cur === 'function' && typeof v === 'function')
        out[k] = (...a: unknown[]) => {
          ;(cur as (...x: unknown[]) => void)(...a)
          ;(v as (...x: unknown[]) => void)(...a)
        }
      else out[k] = v
    }
  }
  return out
}

const MARK_TONE: Record<DesignMark['tone'], string> = {
  violet:
    'bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-200 dark:ring-violet-500/30',
  emerald:
    'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:ring-emerald-500/30',
  amber:
    'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-500/30',
  slate:
    'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700'
}

// Without a provider-measured spot: a full-width line just above / below.
const FALLBACK_INDICATOR: Record<'before' | 'after', CSSProperties> = {
  before: { top: -5, left: 0, right: 0, height: 3 },
  after: { bottom: -5, left: 0, right: 0, height: 3 }
}

export interface DesignNodeOptions {
  /** Inline content (inside a p/span): the shell is a span, not a div. */
  inline?: boolean
  /** Put the shell's attributes on the single child element instead of
   *  wrapping it — grid cells keep their col-span, header tiles their place
   *  in the measured row. */
  asChild?: boolean
  /** A click selects AND reaches the element (tab buttons switch tabs). */
  pass?: boolean
}

export function DesignNode({
  target,
  children,
  inline,
  asChild,
  pass,
  ...rest
}: DesignNodeOptions & {
  target: DesignTarget
  children: ReactNode
  /** Anything else (e.g. HeaderTiles' data-header-cell) lands on the element. */
  [attr: `data-${string}` | `aria-${string}`]: unknown
}) {
  const design = useLayoutDesign()
  const parent = design?.inheritedFrom(target) ?? null
  // The folded copy of a header tile (HeaderTiles) selects but never drags:
  // one draggable per target. A folded tile in the row is out of sight: no
  // drop target.
  const copy = rest['data-design-copy'] !== undefined
  const folded = rest['data-header-folded'] !== undefined
  const locked = !design || !!parent || copy
  // Always called, design or not: the hooks never change between renders.
  const nd = useDesignDndNode(design?.dnd ?? NO_DND, target, { disabled: locked, noDrop: folded })
  if (!design) return <>{children}</>

  const key = targetKey(target)
  const selected = isSelectedIn(design, target)
  const mark = design.roleMark?.(target) ?? null
  const extra = design.marks?.(target) ?? []
  const overlay = design.overlay?.(target) ?? null
  const unsaved = design.unsaved?.(target) ?? false
  const peers = design.peers?.(target) ?? []
  const highlight = extra.some((m) => m.highlight)
  const dragProps = (locked ? {} : nd.props) as Props
  const dragging = nd.dragging
  const slot = locked ? null : nd.slot

  const child = asChild && isValidElement(children) ? (children as ReactElement<ChildProps>) : null
  const childCls = child?.props.className ?? ''
  // A child that positions itself (an absolutely placed step, a tile) keeps
  // its own position — `relative` would override it.
  const positioned = /(^|\s)(absolute|fixed|sticky|relative)(\s|$)/.test(childCls)
  const cls = cn(
    !positioned && 'relative',
    'cursor-pointer rounded-md outline-offset-2',
    !child && (inline ? 'inline-block' : 'block'),
    selected
      ? 'outline outline-2 outline-nvr-cyan'
      : peers.length > 0
        ? `outline outline-2 ${peers[0].outline}`
        : highlight
          ? 'outline-dashed outline-2 outline-violet-400 dark:outline-violet-400/70'
          : 'hover:outline hover:outline-1 hover:outline-slate-300 dark:hover:outline-slate-600',
    overlay?.className,
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-nvr-cyan',
    dragging && 'opacity-40',
    // Hidden for the previewed role: faint, its tags not.
    mark?.kind === 'hidden' && '[&>:not([data-design-badges])]:opacity-40'
  )

  // Capture phase, so nothing inside (inputs, buttons, links) acts on the
  // click: the innermost shell under the pointer selects and swallows it.
  // Outer shells step aside. Elements marked data-design-pass (tab buttons,
  // a section's collapse chevron) still get the click after selection.
  const onClickCapture = (e: MouseEvent<HTMLElement>) => {
    const t = e.target as Element
    if (t.closest('[data-design-target]') !== e.currentTarget) return
    // Shift / ⌘ / Ctrl-click adds to the selection (several fields at once).
    if (e.shiftKey || e.metaKey || e.ctrlKey) design.onSelect(target, { additive: true })
    else design.onSelect(target)
    const through = t.closest('[data-design-pass]')
    if (through && e.currentTarget.contains(through)) return
    e.preventDefault()
    e.stopPropagation()
  }
  // Enter selects from the keyboard too (Space is dnd-kit's pick-up key);
  // only on the node itself, never on a control inside it. A node that IS a
  // native button (a tab or step, asChild) keeps Enter's native click: the
  // click path above selects it and, through data-design-pass, switches to it.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' || e.target !== e.currentTarget) return
    if (e.currentTarget.tagName === 'BUTTON') return
    e.preventDefault()
    if (e.shiftKey) design.onSelect(target, { additive: true })
    else design.onSelect(target)
  }
  // A step or tab button: a chip above it would sit on the step labels.
  const tabLike =
    rest['data-design-tab'] !== undefined ||
    (child?.props as Props | undefined)?.['data-design-tab'] !== undefined
  const own: Props = {
    'data-design-target': key,
    'data-selected': selected ? 'true' : undefined,
    'data-design-pass': pass ? '' : undefined,
    'data-drop-slot': slot ?? undefined,
    'data-role-mark': mark?.kind,
    'data-unsaved': unsaved ? '' : undefined,
    // Locked nodes get no dnd attributes; they still take focus to be selected.
    ...(locked ? { role: 'button', tabIndex: 0 } : {}),
    ...(tabLike && parent ? { 'data-tip': `From ${parent}` } : {}),
    className: cls,
    onClickCapture,
    onKeyDown
  }
  const MarkIcon = mark?.kind === 'hidden' ? EyeOff : Lock
  const tags = extra.length > 0 || overlay != null || peers.length > 0
  const badge =
    tabLike && parent && !mark && !tags ? (
      // Steps and tabs: a dot above the label, the parent's name in the tip.
      <span
        data-design-badges=''
        className='pointer-events-none absolute left-1/2 top-1 z-10 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-slate-500 dark:bg-slate-400'
      >
        <span className='sr-only'>from {parent}</span>
      </span>
    ) : parent || mark || tags ? (
      <span
        data-design-badges=''
        className='pointer-events-none absolute -top-2 right-1 z-10 flex items-center gap-1'
      >
        {mark && (
          <span
            data-design-role-tag={mark.kind}
            className='inline-flex items-center gap-0.5 rounded bg-amber-50 px-1 text-[11px] text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-500/30'
          >
            <MarkIcon aria-hidden className='h-3 w-3' />
            {mark.kind === 'hidden' ? 'Hidden' : 'Read-only'} for {mark.role}
          </span>
        )}
        {extra.map((m) => (
          <span
            key={m.text}
            data-design-mark=''
            data-tip={m.tip}
            className={cn(
              'inline-flex items-center rounded px-1 text-[11px] ring-1',
              m.tip && 'pointer-events-auto',
              MARK_TONE[m.tone]
            )}
          >
            {m.text}
          </span>
        ))}
        {parent && (
          <span className='rounded bg-slate-100 px-1 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300'>
            from {parent}
          </span>
        )}
        {overlay && (
          <span data-design-pass='' className='pointer-events-auto'>
            {overlay.chip}
          </span>
        )}
        {peers.map((p) => (
          <span
            key={p.id}
            data-design-peer={p.id}
            className={cn('inline-flex items-center rounded px-1 text-[11px] ring-1', p.chip)}
          >
            {p.name.split(/\s+/)[0]}
          </span>
        ))}
      </span>
    ) : null
  // Unsaved change (#2629): a dot on the node's corner until Save.
  const dot = unsaved ? (
    <span
      data-unsaved-dot=''
      className='pointer-events-none absolute -left-1 -top-1 z-10 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-white dark:bg-amber-400 dark:ring-slate-900'
    >
      <span className='sr-only'>unsaved change</span>
    </span>
  ) : null
  // The insertion line: absolutely placed inside the node, so showing it
  // never moves anything (a border would grow the node and make the drop
  // target jitter under the pointer).
  const indicator = slot ? (
    <span
      aria-hidden
      data-design-drop-indicator={slot}
      className='pointer-events-none absolute z-30 rounded-full bg-nvr-cyan shadow-[0_0_0_2px_#fff] dark:shadow-[0_0_0_2px_#0f172a]'
      style={nd.indicator ?? FALLBACK_INDICATOR[slot]}
    />
  ) : null

  if (child) {
    const { children: inner, ...childOwn } = child.props as Props & { children?: ReactNode }
    return cloneElement(
      child,
      // The child's own classes, style, ref and handlers are kept and merged.
      mergeProps(childOwn, rest as Props, dragProps, own) as ChildProps,
      badge || indicator || dot ? (
        <>
          {dot}
          {badge}
          {indicator}
          {inner}
        </>
      ) : (
        inner
      )
    )
  }
  const Tag = inline ? 'span' : 'div'
  return (
    <Tag {...mergeProps(rest as Props, dragProps, own)}>
      {dot}
      {badge}
      {indicator}
      {children}
    </Tag>
  )
}

/**
 * Wrap `node` in a DesignNode when a design context is active, else return it
 * untouched — no extra component in the normal render path. The node's key
 * moves to the shell so mapped lists keep their identity.
 */
export function designWrap(
  design: LayoutDesign | null,
  target: DesignTarget,
  node: ReactNode,
  opts: DesignNodeOptions = {}
): ReactNode {
  if (!design || node == null || node === false) return node
  const k = isValidElement(node) ? (node.key ?? undefined) : undefined
  return (
    <DesignNode key={k} target={target} {...opts}>
      {node}
    </DesignNode>
  )
}

/** `designWrap` bound to the ambient design context (null outside the canvas). */
export function useDesignWrap() {
  const design = useLayoutDesign()
  return (target: DesignTarget, node: ReactNode, opts?: DesignNodeOptions) =>
    designWrap(design, target, node, opts)
}

/**
 * Makes the element it sits in (a tab, step or container-tab pane) a drop
 * target for `groupKey`'s fields, and draws the drop line there. Renders a
 * hidden span until a drop line shows.
 */
export function DesignDropBody({ groupKey }: { groupKey: string }) {
  const { ref, slot, indicator } = useDesignDropBody(groupKey)
  return (
    <span
      ref={ref}
      aria-hidden
      hidden={!slot}
      data-design-drop-body={groupKey}
      data-design-drop-indicator={slot ?? undefined}
      className='pointer-events-none absolute z-30 rounded-full bg-nvr-cyan shadow-[0_0_0_2px_#fff] dark:shadow-[0_0_0_2px_#0f172a]'
      style={slot ? (indicator ?? FALLBACK_INDICATOR[slot]) : undefined}
    />
  )
}

/** An empty section/tab/step body on the canvas: somewhere to drop fields. */
export function DesignDropZone() {
  return (
    <div
      data-design-drop-zone=''
      className='flex h-16 items-center justify-center rounded-lg border border-dashed border-slate-300 text-[12px] text-slate-400 dark:border-slate-600 dark:text-slate-500'
    >
      Drop fields here
    </div>
  )
}
