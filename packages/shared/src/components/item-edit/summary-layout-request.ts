/**
 * The record form's Summary read: it asks for the Summary pinned to the form
 * it resolved (`for_layout`), and only once that form is known — asking
 * earlier would flash the default Summary before the pinned one.
 */

export function summaryLayoutQueryKey(
  collection: string,
  layoutId: number | null,
  viewport: string | null
): unknown[] {
  return ['summary-layout', collection, layoutId ?? 'none', ...(viewport ? [viewport] : [])]
}

export function summaryLayoutParams(
  layoutId: number | null,
  viewport: string | null
): Record<string, string> | undefined {
  const params: Record<string, string> = {}
  if (layoutId != null) params.for_layout = String(layoutId)
  if (viewport) params.viewport = viewport
  return Object.keys(params).length > 0 ? params : undefined
}

export function summaryLayoutEnabled(opts: {
  isNew: boolean
  designOn: boolean
  layoutResolved: boolean
}): boolean {
  return !opts.isNew && !opts.designOn && opts.layoutResolved
}
