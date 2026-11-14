import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { endBulkProgress, newBulkProgressId, startBulkProgress } from '../../lib/bulk-progress'
import { post } from '../../lib/commands'
import { errorToastOptions } from '../../lib/error-toast'
import { userErrorMessage } from '../../lib/safe-error'
import { invalidateRecordQueries } from '../item-edit/RecordLiveSync'
import { BulkFieldUpdate } from './BulkFieldUpdate'
import { type BulkUpdateAnswer, bulkUpdateOutcome } from './bulk-update-preview'

/**
 * Army 11 N11: the worklist bar's "Update Field" — the same panel and the same
 * server write (`/items/:c/bulk-update`, by form, the form's field rules
 * enforced) as the collection list's bar. A selection spanning several
 * collections has no one form to offer, so the button says so instead.
 */
export function BulkFieldUpdateButton({
  targets,
  disabled,
  className,
  onDone
}: {
  targets: Array<{ collection: string; id: string | number }>
  disabled?: boolean
  className?: string
  onDone?: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const collections = [...new Set(targets.map((t) => t.collection))]
  if (targets.length === 0) return null
  if (collections.length !== 1)
    return (
      <button
        type='button'
        disabled
        data-tip='Pick records of one kind to update a field on them together'
        className={className}
      >
        Update Field
      </button>
    )
  const collection = collections[0]
  const ids = targets.map((t) => t.id)
  const apply = async (field: string, value: unknown) => {
    setBusy(true)
    const progress = newBulkProgressId()
    startBulkProgress(progress, ids)
    try {
      const res = await client.request<BulkUpdateAnswer>(
        post(`/items/${collection}/bulk-update?progress=${progress}`, {
          ids,
          data: { [field]: value ?? null },
          by_form: true
        })
      )
      // Every record that did not change is counted with why (2026-11-13).
      const said = bulkUpdateOutcome(res)
      if (res.refused || res.failed) toast.warning(said, { duration: 8000 })
      else toast.success(said)
      invalidateRecordQueries(qc, collection, ids)
      onDone?.()
    } catch (err) {
      toast.error(
        userErrorMessage(err, 'Could not update the field'),
        errorToastOptions(err, { action: 'Update Field' })
      )
    } finally {
      endBulkProgress(progress)
      setBusy(false)
    }
  }
  return (
    <BulkFieldUpdate
      collection={collection}
      selectedIds={ids}
      disabled={disabled || busy}
      onApply={(f, v) => void apply(f, v)}
      className={className}
    />
  )
}
