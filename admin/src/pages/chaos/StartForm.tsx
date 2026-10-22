import type { CatalogFault } from './api'
import { ExperimentBuilder } from './builder/ExperimentBuilder'
import type { SpecLike } from './builder/model'

/**
 * The start form the Faults tab (and anyone holding a catalog fault) opens inline under a row.
 * Since #2844 it is the experiment builder; the props stay `{fault, onClose}` (+ an optional
 * `initial` spec to pre-fill) so callers do not change.
 */
export function StartForm({
  fault,
  onClose,
  initial
}: {
  fault: CatalogFault
  onClose: () => void
  initial?: SpecLike | null
}) {
  return <ExperimentBuilder fault={fault} onClose={onClose} initial={initial} variant='inline' />
}
