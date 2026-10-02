/**
 * An id that drills: a real <button> that opens the ref on the investigation stack (pushes a
 * level; `root` starts a new investigation) and shows a hover peek card. Use it for every id a
 * panel renders — never navigate away to drill.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { InspectRef } from '../registry/inspectables'
import { refTitle } from './format'
import { IdPeek } from './IdPeek'
import { openInspect } from './stack'

export const INSPECT_LINK =
  'min-w-0 truncate rounded-sm text-left text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

export function InspectLink({
  inspectRef,
  className,
  children,
  root,
  peek = true
}: {
  inspectRef: InspectRef
  className?: string
  children?: ReactNode
  root?: boolean
  /** Hover card (default on). */
  peek?: boolean
}) {
  const btn = (
    <button
      type='button'
      className={cn(INSPECT_LINK, className)}
      data-tm-inspect-link={`${inspectRef.kind}:${inspectRef.id}`}
      onClick={(e) => {
        e.stopPropagation()
        openInspect(inspectRef, { root })
      }}
    >
      {children ?? refTitle(inspectRef)}
    </button>
  )
  if (!peek) return btn
  return (
    <IdPeek inspectRef={inspectRef} root={root}>
      {btn}
    </IdPeek>
  )
}
