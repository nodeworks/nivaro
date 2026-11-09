import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import type { CompareFieldMeta } from '../../lib/compare-value'
import type { CMSField, CMSRelation } from '../item-edit/types'
import { RecordCompareDialog } from '../RecordCompare'

/** Record compare takes two or three records (#2723). */
export const COMPARE_MIN = 2
export const COMPARE_MAX = 3

/** Whether a selection can be compared: 2–3 records of one collection. Pure. */
export function compareTargets(
  targets: Array<{ collection: string; id: string | number }>
): { collection: string; ids: Array<string | number> } | null {
  const collections = [...new Set(targets.map((t) => t.collection))]
  if (collections.length !== 1) return null
  if (targets.length < COMPARE_MIN || targets.length > COMPARE_MAX) return null
  return { collection: collections[0], ids: targets.map((t) => t.id) }
}

/**
 * Bulk-bar "Compare" (shared by the collection list and the worklist bar,
 * army 11 N11): two or three records side by side, each read as the viewer.
 * Shown only for a 2–3 record selection of one collection — the list bar's
 * rule. The host says how a value reads (`renderValue`: relations as labels);
 * the collection's fields and relations are read here when not handed in.
 */
export function BulkCompareButton<R = CMSRelation>({
  targets,
  renderValue,
  fields,
  relations,
  disabled,
  className
}: {
  targets: Array<{ collection: string; id: string | number }>
  renderValue: (relations: R[], field: string, value: unknown, meta?: CompareFieldMeta) => ReactNode
  /** The collection's fields in order, when the host already has them. */
  fields?: Array<{ field: string; hidden?: boolean }>
  relations?: R[]
  disabled?: boolean
  className?: string
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const pick = compareTargets(targets)
  const collection = pick?.collection ?? ''
  const fieldsQ = useQuery<CMSField[]>({
    queryKey: ['bulk-fields-config', collection],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(get(`/field-config/${collection}`))
        .then((r) => (Array.isArray(r.data) ? r.data : [])),
    enabled: open && !!pick && !fields,
    staleTime: 60_000
  })
  const relationsQ = useQuery<R[]>({
    queryKey: ['bulk-fields-relations', collection],
    queryFn: () =>
      client
        .request<{ data: R[] }>(get(`/data-model/relations/for/${collection}`))
        .then((r) => (Array.isArray(r.data) ? r.data : [])),
    enabled: open && !!pick && !relations,
    staleTime: 60_000
  })
  if (!pick) return null
  const rels = relations ?? relationsQ.data ?? []
  return (
    <>
      <button
        type='button'
        disabled={disabled}
        onClick={() => setOpen(true)}
        data-bulk-compare
        className={className}
      >
        Compare
      </button>
      {open && (
        <RecordCompareDialog
          collection={pick.collection}
          ids={pick.ids}
          fields={fields ?? fieldsQ.data ?? []}
          renderValue={(f, v, m) => renderValue(rels, f, v, m)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
