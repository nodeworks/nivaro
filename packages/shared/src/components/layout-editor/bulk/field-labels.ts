import { useMemo } from 'react'
import { titleCase } from '../../../lib/utils'
import { useOverviewFields } from '../overview/overview-api'
import type { PickOption } from '../settings/controls'
import { usePlacedFields } from './bulk-api'

/** Field labels for pickers and sentences: the field's label, else its name in title case. */
export function useFieldLabels(collection: string) {
  const { data: fieldRows } = useOverviewFields(collection)
  const { data: placedRows } = usePlacedFields(collection)
  return useMemo(() => {
    const fields = fieldRows ?? []
    const placed = placedRows ?? []
    const labels: Record<string, string> = {}
    for (const f of fields) labels[f.field] = f.label || titleCase(f.field)
    for (const p of placed) labels[p.field] ??= titleCase(p.field)
    const formsOf = new Map(placed.map((p) => [p.field, p.forms]))
    const all: PickOption[] = Object.keys(labels)
      .filter((f) => !f.startsWith('__'))
      .map((f) => ({ value: f, label: labels[f], hint: f }))
      .sort((a, b) => a.label.localeCompare(b.label))
    const onForms: PickOption[] = placed
      .map((p) => ({
        value: p.field,
        label: labels[p.field],
        hint: `${p.forms} form${p.forms === 1 ? '' : 's'}`
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
    return { labels, all, onForms, formsOf }
  }, [fieldRows, placedRows])
}
