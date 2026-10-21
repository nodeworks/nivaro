import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import type { LayoutBundle } from '../../../lib/layout-ops'
import { apiFailure, useInvalidateLayouts } from '../overview/overview-api'
import type { OverviewRow } from '../overview/types'
import { copySection, leftOutWords } from './reuse-api'

/**
 * #2584: a section dropped on a layout in the rail is copied there (same
 * collection: fields keep their names) through that layout's ops. The open
 * layout does not change, so its undo history is untouched; the toast offers
 * to open the copy.
 */
export function useRailCopy(
  collection: string,
  bundle: LayoutBundle | null,
  rows: OverviewRow[],
  openLayout: (layoutId: number) => void
) {
  const client = useNivaroClient()
  const invalidate = useInvalidateLayouts(collection)
  // Read at drop time: the drop handler outlives renders.
  const latest = useRef({ bundle, rows, openLayout })
  latest.current = { bundle, rows, openLayout }
  return useCallback(
    async (groupKey: string, layoutId: number) => {
      const { bundle: b, rows: list } = latest.current
      if (!b) return
      const label = b.groups.find((g) => g.key === groupKey)?.label || groupKey
      const to = list.find((r) => r.layout_id === layoutId)?.name ?? 'that layout'
      try {
        const res = await copySection(client, layoutId, {
          source_layout_id: Number(b.layout.id),
          group_key: groupKey,
          source_bundle: b
        })
        invalidate({ lazy: true })
        const extra = leftOutWords(res)
        toast.success(`Copied ${label} to ${to}${extra ? ` (${extra})` : ''}`, {
          action: { label: 'Open', onClick: () => latest.current.openLayout(layoutId) }
        })
      } catch (err) {
        toast.error(apiFailure(err, `Could not copy ${label}`).message)
      }
    },
    [client, invalidate]
  )
}
