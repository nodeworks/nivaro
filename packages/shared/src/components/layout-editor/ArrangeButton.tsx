import { Shuffle } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { DesignTarget } from './design-context'
import { barBtn } from './toolbar-kit'

// The inspector's way into the canvas menu (StructureMenu): its buttons
// dispatch an event the editor's StructureActions answers, so the inspector
// needs no handle on the editor.

/** Inspector buttons open the menu by dispatching this event from themselves. */
export const STRUCTURE_MENU_EVENT = 'nvr-layout-structure-menu'

export function openStructureMenu(from: HTMLElement, targets: DesignTarget[]) {
  from.dispatchEvent(new CustomEvent(STRUCTURE_MENU_EVENT, { bubbles: true, detail: { targets } }))
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform)
export const duplicateKeys = () => (isMac() ? '⌘D' : 'Ctrl+D')

/** The inspector's Arrange button for a section: opens the canvas menu beside it. */
export function ArrangeButton({
  targets,
  className
}: {
  targets: DesignTarget[]
  className?: string
}) {
  return (
    <button
      type='button'
      data-structure-open=''
      onClick={(e) => openStructureMenu(e.currentTarget, targets)}
      data-tip={`Duplicate (${duplicateKeys()}), wrap, unwrap, convert, copy rules, pin — or right-click it on the form`}
      className={cn(barBtn, className)}
    >
      <Shuffle className='h-3.5 w-3.5 shrink-0' />
      Arrange…
    </button>
  )
}
