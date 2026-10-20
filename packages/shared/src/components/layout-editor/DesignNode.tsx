import {
  cloneElement,
  isValidElement,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { cn } from '../../lib/utils'
import type { DesignTarget, LayoutDesign } from './design-context'
import { targetKey, useLayoutDesign } from './design-context'

type ChildProps = { className?: string; children?: ReactNode }

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
  const dragging = design.dnd.isDragging(target)
  const slot = design.dnd.dropSlot(target)
  const dragProps = parent ? {} : design.dnd.draggableProps(target)

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
    dragging && 'opacity-40',
    slot === 'before' && 'border-t-2 border-nvr-cyan',
    slot === 'after' && 'border-b-2 border-nvr-cyan'
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
  const props = {
    ...rest,
    ...dragProps,
    'data-design-target': key,
    'data-selected': selected ? 'true' : undefined,
    'data-design-pass': pass ? '' : undefined,
    onClickCapture
  }
  const badge = parent ? (
    <span className='absolute -top-2 right-1 z-10 rounded bg-slate-100 px-1 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300'>
      from {parent}
    </span>
  ) : null

  if (child) {
    return cloneElement(
      child,
      // Plain concatenation: the child's own classes are never merged away.
      { ...props, className: [childCls, cls].filter(Boolean).join(' ') } as ChildProps,
      badge ? (
        <>
          {badge}
          {child.props.children}
        </>
      ) : (
        child.props.children
      )
    )
  }
  const Tag = inline ? 'span' : 'div'
  return (
    <Tag {...props} className={cls}>
      {badge}
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
