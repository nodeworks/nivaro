import {
  type CSSProperties,
  cloneElement,
  isValidElement,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react'
import { cn } from '../../lib/utils'
import type { DesignTarget, LayoutDesign } from './design-context'
import { targetKey, useLayoutDesign } from './design-context'

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
  if (!design) return <>{children}</>

  const key = targetKey(target)
  const selected = design.selected != null && targetKey(design.selected) === key
  const parent = design.inheritedFrom(target)
  // The folded copy of a header tile (HeaderTiles) selects but never drags:
  // one draggable per target.
  const copy = rest['data-design-copy'] !== undefined
  const locked = !!parent || copy
  const dndProps = design.dnd.draggableProps(target, locked ? { disabled: true } : undefined)
  const dragProps = (locked ? {} : dndProps) as Props
  const dragging = design.dnd.isDragging(target)
  const slot = locked ? null : design.dnd.dropSlot(target)

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
      : 'hover:outline hover:outline-1 hover:outline-slate-300 dark:hover:outline-slate-600',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-nvr-cyan',
    dragging && 'opacity-40'
  )

  // Capture phase, so nothing inside (inputs, buttons, links) acts on the
  // click: the innermost shell under the pointer selects and swallows it.
  // Outer shells step aside. Elements marked data-design-pass (tab buttons,
  // a section's collapse chevron) still get the click after selection.
  const onClickCapture = (e: MouseEvent<HTMLElement>) => {
    const t = e.target as Element
    if (t.closest('[data-design-target]') !== e.currentTarget) return
    design.onSelect(target)
    const through = t.closest('[data-design-pass]')
    if (through && e.currentTarget.contains(through)) return
    e.preventDefault()
    e.stopPropagation()
  }
  const own: Props = {
    'data-design-target': key,
    'data-selected': selected ? 'true' : undefined,
    'data-design-pass': pass ? '' : undefined,
    'data-drop-slot': slot ?? undefined,
    className: cls,
    onClickCapture
  }
  const badge = parent ? (
    <span className='absolute -top-2 right-1 z-10 rounded bg-slate-100 px-1 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300'>
      from {parent}
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
      style={design.dnd.dropIndicator?.(target) ?? FALLBACK_INDICATOR[slot]}
    />
  ) : null

  if (child) {
    const { children: inner, ...childOwn } = child.props as Props & { children?: ReactNode }
    return cloneElement(
      child,
      // The child's own classes, style, ref and handlers are kept and merged.
      mergeProps(childOwn, rest as Props, dragProps, own) as ChildProps,
      badge || indicator ? (
        <>
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
