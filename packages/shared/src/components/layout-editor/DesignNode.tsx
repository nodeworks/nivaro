import type { ReactNode } from 'react'
import type { DesignTarget } from './design-context'
import { targetKey, useLayoutDesign } from './design-context'

export function DesignNode({
  target,
  children,
  inline
}: {
  target: DesignTarget
  children: ReactNode
  inline?: boolean
}) {
  const design = useLayoutDesign()
  if (!design) return <>{children}</>

  const key = targetKey(target)
  const selected = design.selected != null && targetKey(design.selected) === key
  const parent = design.inheritedFrom(target)
  const dragging = design.dnd.isDragging(target)
  const slot = design.dnd.dropSlot(target)
  const dragProps = parent ? {} : design.dnd.draggableProps(target)

  const cls = [
    'relative cursor-pointer rounded-md outline-offset-2',
    inline ? 'inline-block' : 'block',
    selected
      ? 'outline outline-2 outline-nvr-cyan'
      : 'hover:outline hover:outline-1 hover:outline-slate-300 dark:hover:outline-slate-600',
    dragging ? 'opacity-40' : '',
    slot === 'before' ? 'border-t-2 border-nvr-cyan' : '',
    slot === 'after' ? 'border-b-2 border-nvr-cyan' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: design-mode selection target
    // biome-ignore lint/a11y/noStaticElementInteractions: design-mode selection target
    <div
      {...dragProps}
      data-design-target={key}
      data-selected={selected ? 'true' : undefined}
      className={cls}
      onClick={(e) => {
        e.stopPropagation()
        design.onSelect(target)
      }}
    >
      {parent && (
        <span className='absolute -top-2 right-1 z-10 rounded bg-slate-100 px-1 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300'>
          from {parent}
        </span>
      )}
      {children}
    </div>
  )
}
