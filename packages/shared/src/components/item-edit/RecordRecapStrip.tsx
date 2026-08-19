import { useEffect, useRef, useState } from 'react'
import { History, X } from 'lucide-react'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { formatRelative } from '../../lib/utils'

interface Recap {
  since: string
  field_changes: number
  fields: string[]
  comments: number
  transitions: number
  editors: string[]
}

/**
 * "Since you last looked" — opening a saved record touches the per-user view
 * watermark and, when other people changed the record in between, renders a
 * one-line recap above the form. The server owns the session semantics (a
 * refresh within 30 minutes keeps the same baseline), the strip just shows
 * whatever the touch returned. Dismiss is per-mount — the next genuine visit
 * recomputes against the new baseline anyway.
 */
export function RecordRecapStrip({
  collection,
  itemId
}: {
  collection: string
  itemId: string
}) {
  const client = useNivaroClient()
  const [recap, setRecap] = useState<Recap | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const touchedRef = useRef<string | null>(null)

  useEffect(() => {
    const key = `${collection}|${itemId}`
    if (touchedRef.current === key) return
    touchedRef.current = key
    setRecap(null)
    setDismissed(false)
    client
      .request<{ data: Recap | null }>(
        post(`/record-views/${collection}/${encodeURIComponent(itemId)}/touch`, {})
      )
      .then((r) => setRecap(r.data ?? null))
      .catch(() => {
        // A failed touch must never mark the record as "seen" — clear the
        // guard so a remount retries, and show nothing.
        touchedRef.current = null
      })
  }, [client, collection, itemId])

  if (!recap || dismissed) return null

  const parts: string[] = []
  if (recap.field_changes > 0) {
    parts.push(`${recap.field_changes} field${recap.field_changes === 1 ? '' : 's'} changed`)
  }
  if (recap.comments > 0) parts.push(`${recap.comments} new comment${recap.comments === 1 ? '' : 's'}`)
  if (recap.transitions > 0) {
    parts.push(`${recap.transitions} workflow transition${recap.transitions === 1 ? '' : 's'}`)
  }
  const who = recap.editors.length > 0 ? ` by ${recap.editors.join(', ')}` : ''

  return (
    <div
      className='flex items-center gap-3 rounded-lg border border-sky-200 bg-sky-50 px-3.5 py-2 dark:border-sky-500/30 dark:bg-sky-500/10'
      data-record-recap
    >
      <History className='h-4 w-4 shrink-0 text-sky-500' />
      <p
        className='min-w-0 flex-1 truncate text-[12px] text-sky-800 dark:text-sky-300'
        data-tip={recap.fields.length > 0 ? `Changed: ${recap.fields.join(', ')}` : undefined}
      >
        Since you last viewed ({formatRelative(recap.since)}):{' '}
        <span className='font-medium'>{parts.join(' · ')}</span>
        {who}
      </p>
      <button
        type='button'
        onClick={() => setDismissed(true)}
        aria-label='Dismiss recap'
        className='shrink-0 rounded p-0.5 text-sky-400 hover:bg-sky-100 hover:text-sky-600 dark:hover:bg-sky-500/15'
      >
        <X className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}
