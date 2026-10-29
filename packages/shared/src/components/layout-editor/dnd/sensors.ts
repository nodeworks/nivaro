import { PointerSensor, TouchSensor } from '@dnd-kit/core'
import type { PointerEvent as ReactPointerEvent } from 'react'

// Touch on the layout editor canvas (#3193). A mouse or pen drags after 4px of
// movement (PointerSensor). A finger has to press and hold first (TouchSensor,
// 250 ms, 8 px of slack): a quick swipe still scrolls the canvas, a tap still
// selects. Pointer events alone cannot hold the page still once a touch drag
// is under way (the browser takes the gesture for a scroll and cancels the
// pointer); TouchSensor's touchmove is cancelable, so the page stays put.

export const MOUSE_ACTIVATION = { distance: 4 } as const
export const TOUCH_ACTIVATION = { delay: 250, tolerance: 8 } as const

type Activator = (typeof PointerSensor.activators)[number]

/** PointerSensor for mice and pens only: touches go to TouchSensor. */
export class MousePointerSensor extends PointerSensor {
  static activators: Activator[] = [
    {
      eventName: 'onPointerDown',
      handler: (e: ReactPointerEvent, opts: Parameters<Activator['handler']>[1]) => {
        if (e.nativeEvent?.pointerType === 'touch') return false
        return PointerSensor.activators[0].handler(e, opts)
      }
    }
  ]
}

export { TouchSensor }
