import { History, Mail, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { formatRelative } from '../../lib/utils'
import { RelativeTime } from '../RelativeTime'

interface Recap {
  since: string
  field_changes: number
  fields: string[]
  comments: number
  transitions: number
  editors: string[]
}

interface EmailSince {
  since: string
  moved_to: { label: string; color: string | null } | null
  transitions: number
  field_changes: number
  fields: string[]
  comments: number
}

/** The `since` an email link carried (`?since=<iso>`), or null. Exported for tests. */
export function emailSinceFromSearch(search: string): string | null {
  try {
    const v = new URLSearchParams(search).get('since')
    if (!v || v.length > 40 || !Number.isFinite(Date.parse(v))) return null
    return v
  } catch {
    return null
  }
}

/** "moved to Approved · 2 fields changed · 1 new comment". Exported for tests. */
export function emailSinceParts(s: EmailSince): string[] {
  const parts: string[] = []
  if (s.moved_to) parts.push(`moved to ${s.moved_to.label}`)
  if (s.field_changes > 0)
    parts.push(`${s.field_changes} field${s.field_changes === 1 ? '' : 's'} changed`)
  if (s.comments > 0) parts.push(`${s.comments} new comment${s.comments === 1 ? '' : 's'}`)
  return parts
}

/** Drop `since` from the address bar without a navigation (a reload keeps the strip away). */
function forgetSinceParam(): void {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('since')) return
    url.searchParams.delete('since')
    window.history.replaceState(window.history.state, '', url.toString())
  } catch {
    /* the strip still hides */
  }
}

/**
 * "Since you last looked" — opening a saved record touches the per-user view
 * watermark and, when other people changed the record in between, renders a
 * one-line recap above the form. The server owns the session semantics (a
 * refresh within 30 minutes keeps the same baseline), the strip just shows
 * whatever the touch returned. Dismiss POSTs /dismiss, which collapses the
 * server baseline to now — a reload inside the session grace stays quiet, and
 * only changes made after the dismissal come back as news.
 *
 * Opened from an email (realtime round 3 #2): the link carries the send time
 * (`?since=`), and the strip instead says quietly what happened since that
 * email — "Since this email: moved to Approved · 2 fields changed" — judged by
 * the server as the viewer (only fields they may read). Dismissing it drops
 * `since` from the address.
 */
export function RecordRecapStrip({ collection, itemId }: { collection: string; itemId: string }) {
  const client = useNivaroClient()
  const [recap, setRecap] = useState<Recap | null>(null)
  const [emailSince, setEmailSince] = useState<EmailSince | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const touchedRef = useRef<string | null>(null)

  useEffect(() => {
    const key = `${collection}|${itemId}`
    if (touchedRef.current === key) return
    touchedRef.current = key
    setRecap(null)
    setEmailSince(null)
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
    const at = typeof window === 'undefined' ? null : emailSinceFromSearch(window.location.search)
    if (at) {
      client
        .request<{ data: EmailSince | null }>(
          get(`/record-views/${collection}/${encodeURIComponent(itemId)}/since`, { at })
        )
        .then((r) => setEmailSince(r.data ?? null))
        .catch(() => {
          /* the email strip is a courtesy — nothing on failure */
        })
    }
  }, [client, collection, itemId])

  const dismiss = () => {
    setDismissed(true)
    if (emailSince) {
      forgetSinceParam()
      return
    }
    // Best effort — a failed dismiss just means the strip may come back on
    // the next reload, which is the old behaviour, never worse.
    client
      .request(post(`/record-views/${collection}/${encodeURIComponent(itemId)}/dismiss`, {}))
      .catch(() => {})
  }

  if (dismissed) return null

  if (emailSince) {
    const parts = emailSinceParts(emailSince)
    if (parts.length === 0) return null
    return (
      <div
        className='nvr-expand-in flex items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 dark:border-border dark:bg-white/[0.03]'
        data-record-since-email
      >
        <Mail className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500' />
        <p
          className='min-w-0 flex-1 truncate text-[12px] text-slate-600 dark:text-slate-300'
          data-tip={
            emailSince.fields.length > 0
              ? `Changed: ${emailSince.fields.join(', ')}`
              : `Email sent ${formatRelative(emailSince.since)}`
          }
        >
          <span className='text-slate-500 dark:text-slate-400'>Since this email:</span>{' '}
          {emailSince.moved_to && (
            <span
              aria-hidden
              className='mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle'
              style={{ backgroundColor: emailSince.moved_to.color ?? '#94a3b8' }}
            />
          )}
          <span className='font-medium text-slate-700 dark:text-slate-200'>
            {parts.join(' · ')}
          </span>
        </p>
        <button
          type='button'
          onClick={dismiss}
          aria-label='Dismiss'
          className='shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-300'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
    )
  }

  if (!recap) return null

  const parts: string[] = []
  if (recap.field_changes > 0) {
    parts.push(`${recap.field_changes} field${recap.field_changes === 1 ? '' : 's'} changed`)
  }
  if (recap.comments > 0)
    parts.push(`${recap.comments} new comment${recap.comments === 1 ? '' : 's'}`)
  if (recap.transitions > 0) {
    parts.push(`${recap.transitions} workflow transition${recap.transitions === 1 ? '' : 's'}`)
  }
  const who = recap.editors.length > 0 ? ` by ${recap.editors.join(', ')}` : ''

  return (
    <div
      className='nvr-expand-in flex items-center gap-3 rounded-lg border border-sky-200 bg-sky-50 px-3.5 py-2 dark:border-sky-500/30 dark:bg-sky-500/10'
      data-record-recap
    >
      <History className='h-4 w-4 shrink-0 text-sky-500' />
      <p
        className='min-w-0 flex-1 truncate text-[12px] text-sky-800 dark:text-sky-300'
        data-tip={recap.fields.length > 0 ? `Changed: ${recap.fields.join(', ')}` : undefined}
      >
        Since you last viewed (<RelativeTime value={recap.since} />
        ): <span className='font-medium'>{parts.join(' · ')}</span>
        {who}
      </p>
      <button
        type='button'
        onClick={dismiss}
        aria-label='Dismiss recap'
        className='shrink-0 rounded p-0.5 text-sky-400 hover:bg-sky-100 hover:text-sky-600 dark:hover:bg-sky-500/15'
      >
        <X className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}
