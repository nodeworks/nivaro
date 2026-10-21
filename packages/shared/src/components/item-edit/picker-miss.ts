import { useEffect, useRef } from 'react'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'

/** Where a picker sits on a record form: enough for the server to count a miss per placement. */
export interface PickerMissPlacement {
  layoutId: number
  collection: string
  field: string
}

const MAX_TERMS = 3

/**
 * #2726 — picker search gaps. While a record-form picker is open, every
 * settled search that found nothing is remembered; when the picker closes,
 * the words go to the server once (`POST /layout-usage/picker-miss`), which
 * keeps only an aggregate count per placement for 14 days. Fire and forget.
 */
export function usePickerMissReport(opts: {
  placement: PickerMissPlacement | null | undefined
  open: boolean
  /** The search the shown options answer (debounced). */
  search: string
  settled: boolean
  count: number
}): void {
  const client = useNivaroClient()
  const terms = useRef<string[]>([])
  const { placement, open, search, settled, count } = opts

  useEffect(() => {
    if (!placement || !open || !settled || count > 0) return
    const t = search.trim()
    if (t.length < 2 || terms.current.includes(t)) return
    terms.current = [...terms.current, t].slice(-MAX_TERMS * 2)
  }, [placement, open, search, settled, count])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reports only when the picker closes
  useEffect(() => {
    if (open || terms.current.length === 0) return
    const sent = terms.current
    terms.current = []
    if (!placement) return
    void client
      .request(
        post('/layout-usage/picker-miss', {
          layout_id: placement.layoutId,
          collection: placement.collection,
          field: placement.field,
          terms: sent
        })
      )
      .catch(() => {})
  }, [open])
}
