import * as PopoverPrimitive from '@radix-ui/react-popover'
import * as React from 'react'

import { cn } from '../../lib/utils'

function modalHostOf(el: HTMLElement | null): HTMLElement | undefined {
  let node: HTMLElement | null = el?.parentElement ?? null
  while (node) {
    const dialog: HTMLElement | null = node.closest('[role="dialog"]')
    if (!dialog) return undefined
    if (!dialog.closest('[data-radix-popper-content-wrapper]')) return dialog
    node = dialog.parentElement
  }
  return undefined
}

const Popover = PopoverPrimitive.Root

const PopoverTrigger = PopoverPrimitive.Trigger

const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => {
  // A modal dialog or sheet locks scrolling to its own subtree, so a popover
  // portaled to <body> from inside one can be seen and clicked but not
  // scrolled — wheel and scrollbar both go dead. The marker below sits where
  // the popover is declared; when that is inside a modal, the popover mounts
  // inside the modal too. Another popover's content also carries
  // role="dialog" and is skipped — it is not a scroll lock.
  const [marker, setMarker] = React.useState<HTMLSpanElement | null>(null)
  const container = React.useMemo(() => modalHostOf(marker), [marker])
  return (
    <>
      <span ref={setMarker} hidden data-nvr-popover-marker='' />
      <PopoverPrimitive.Portal container={container}>
        <PopoverPrimitive.Content
          ref={ref}
          align={align}
          sideOffset={sideOffset}
          className={cn(
            'z-[110] w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-popover-content-transform-origin]',
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Portal>
    </>
  )
})
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }
