import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { useCollectionMeta } from '../inspector/field-context'
import { apiFailure, useInvalidateLayouts } from '../overview/overview-api'
import { createFormFromFields } from './NewFormStart'
import { recordSeedFields } from './seed'

/**
 * #2585 "Make a form that shows what this record has filled in": reads the
 * record, creates a form (not active, not in the New menu's default) with one
 * section holding its non-empty fields in field order, and hands back its id.
 */
export function useFormFromRecord(collection: string) {
  const client = useNivaroClient()
  const { data: meta } = useCollectionMeta(collection)
  const invalidate = useInvalidateLayouts(collection)
  const [busy, setBusy] = useState(false)

  const make = useCallback(
    async (recordId: string | number, recordLabel: string): Promise<number | null> => {
      if (busy) return null
      setBusy(true)
      try {
        const res = await client.request<{ data: Record<string, unknown> | null }>(
          get(`/items/${encodeURIComponent(collection)}/${encodeURIComponent(String(recordId))}`)
        )
        if (!res?.data) throw new Error('That record could not be read')
        const fields = recordSeedFields(res.data, meta?.fields ?? [])
        if (!fields.length) throw new Error('This record has nothing filled in yet')
        const base = `Form from ${recordLabel}`.slice(0, 90)
        // The name is taken (made from this record before): number the next one.
        let id: number | null = null
        let name = base
        for (let n = 2; id == null; n++) {
          try {
            id = await createFormFromFields(client, { collection, name, fields })
            if (id == null) throw new Error('No id came back')
          } catch (err) {
            if (apiFailure(err, '').status !== 409 || n > 6) throw err
            name = `${base} (${n})`
          }
        }
        invalidate()
        toast.success(`Made ${name} with ${fields.length} fields`)
        return id
      } catch (err) {
        toast.error(apiFailure(err, 'Could not make the form').message)
        return null
      } finally {
        setBusy(false)
      }
    },
    [busy, client, collection, meta, invalidate]
  )
  return { make, busy, ready: !!meta }
}
