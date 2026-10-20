import { type ComponentProps, lazy, Suspense, useRef } from 'react'
import type { HelpVideoSheet } from './HelpVideoSheet'

const Sheet = lazy(() => import('./HelpVideoSheet').then((m) => ({ default: m.HelpVideoSheet })))

/**
 * HelpVideoSheet, loaded the first time it opens. The buttons and cards that
 * open it sit on every screen; the player does not need to load with them.
 * Kept mounted once used, so closing still animates and hands focus back.
 */
export function LazyHelpVideoSheet(props: ComponentProps<typeof HelpVideoSheet>) {
  const used = useRef(false)
  if (props.open) used.current = true
  if (!used.current) return null
  return (
    <Suspense fallback={null}>
      <Sheet {...props} />
    </Suspense>
  )
}
