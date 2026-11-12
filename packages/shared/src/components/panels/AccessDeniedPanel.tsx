import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeft, Check, Lock, Send } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { hasRecordExtras } from '../../lib/system-collections'

// ─── Access denied explanation ───────────────────────────────────────────────
// Rendered by ItemEditForm when the record load 403/404s. A scoped user used
// to get a silently empty form — this asks /access-explain WHY and says it in
// plain language (role permission, RLS row filter, or which User Scope
// dimension excludes the record and what the user IS limited to).

interface AccessReason {
  type: 'permission' | 'not_found' | 'row_filter' | 'scope' | 'scope_strict'
  message: string
  dimension?: string
  dimension_label?: string
  allowed_values?: string[]
}

/** What /access-explain's own 404 means: there is no such record to
 *  explain (an id no record can have — a 400-digit number, junk). Reading it
 *  as "no answer" titled the panel "You can't view this record". */
const NOT_FOUND_EXPLAIN: { access: boolean; reasons: AccessReason[] } = {
  access: false,
  reasons: [{ type: 'not_found', message: 'There is no record with this id.' }]
}
export function explainMissing(err: unknown): boolean {
  // The SDK puts the code on err.status; an axios-backed client on err.response.
  const e = err as { status?: number; response?: { status?: number } } | null
  const status = e?.status ?? e?.response?.status
  return status === 404
}

/**
 * What the panel calls the record: the collection's singular label when the host knows it
 * ("Invoice"), else the table key made readable ("inventory_request" → "inventory request",
 * "invoices" → "invoice"). Never the row id or the raw key (army 8 b14: the panel read
 * "invoices · #5715898" — a database row id people cannot use). Exported for tests.
 */
export function recordNoun(collection: string, singular?: string | null): string {
  const s = singular?.trim()
  if (s) return s.toLowerCase()
  const words = collection.replace(/_/g, ' ').trim()
  if (/ies$/i.test(words)) return words.replace(/ies$/i, 'y')
  if (/[^su]s$/i.test(words)) return words.slice(0, -1)
  return words || 'record'
}

/** The access-request route keeps 300 characters of the note. */
const NOTE_MAX = 300

export function AccessDeniedPanel({
  collection,
  itemId,
  noun: nounProp,
  onBack
}: {
  collection: string
  itemId: string
  /** The collection's singular label ("Invoice") — names the record in the title. */
  noun?: string | null
  /** Host-provided back action (e.g. navigate(-1)); renders a button when set. */
  onBack?: () => void
}) {
  const noun = recordNoun(collection, nounProp)
  const client = useNivaroClient()
  const [requested, setRequested] = useState(false)
  // Army 11: the person may say why — the administrator used to read only a canned sentence.
  const [note, setNote] = useState('')
  const requestAccess = useMutation({
    mutationFn: () =>
      client.request(
        post('/access-requests', {
          collection,
          item: String(itemId),
          ...(note.trim() ? { note: note.trim().slice(0, NOTE_MAX) } : {})
        })
      ),
    onSuccess: () => {
      setRequested(true)
      toast.success('Access request sent — an administrator has been notified')
    },
    onError: () => toast.error('Could not send the request')
  })
  const { data, isLoading } = useQuery<{ access: boolean; reasons: AccessReason[] } | null>({
    queryKey: ['access-explain', collection, String(itemId)],
    queryFn: () =>
      client
        .request<{ data: { access: boolean; reasons: AccessReason[] } }>(
          get(`/access-explain/${collection}/${encodeURIComponent(itemId)}`)
        )
        .then((r) => r.data ?? null)
        .catch((err: unknown) => (explainMissing(err) ? NOT_FOUND_EXPLAIN : null)),
    // "Why can't I see this" is refused for system tables by name: the plain message stands.
    enabled: hasRecordExtras(collection),
    staleTime: 30_000
  })

  const reasons = data?.reasons ?? []
  const notFound = reasons.some((r) => r.type === 'not_found')

  return (
    <div className='flex flex-1 items-start justify-center px-6 py-16'>
      <div className='w-full max-w-[560px] rounded-xl border border-slate-200 bg-white p-8 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <span className='flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-muted'>
            <Lock className='h-[18px] w-[18px] text-slate-500 dark:text-slate-400' />
          </span>
          <div>
            <h2 className='text-[15px] font-semibold text-slate-800 dark:text-slate-100'>
              {notFound
                ? `${noun.charAt(0).toUpperCase()}${noun.slice(1)} not found`
                : `You can't view this ${noun}`}
            </h2>
            <p className='text-[12px] text-slate-500 dark:text-slate-400'>
              {notFound
                ? 'The link may be wrong, or it was removed.'
                : 'It is outside what your access lets you see.'}
            </p>
          </div>
        </div>

        <div className='mt-5 space-y-2.5'>
          {isLoading ? (
            <>
              <div className='animate-pulse h-4 w-3/4 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
              <div className='animate-pulse h-4 w-1/2 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
            </>
          ) : notFound ? null : reasons.length > 0 ? (
            // A missing record is said once, in the heading (army11 f3: the
            // page gave two different reasons for the same thing).
            reasons.map((r, i) => (
              <div
                key={`${r.type}-${r.dimension ?? i}`}
                className='rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-300'
              >
                {r.message}
              </div>
            ))
          ) : (
            <div className='rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-300'>
              This record could not be loaded. It may have been deleted, or an access rule may be
              hiding it.
            </div>
          )}
        </div>

        {!notFound && !isLoading && !requested && (
          <div className='mt-4'>
            <label
              htmlFor={`access-note-${collection}-${itemId}`}
              className='block text-[12px] font-medium text-slate-700 dark:text-slate-300'
            >
              Need it? Say what for <span className='font-normal text-slate-500'>(optional)</span>
            </label>
            <textarea
              id={`access-note-${collection}-${itemId}`}
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
              rows={2}
              maxLength={NOTE_MAX}
              placeholder={`e.g. I approve this ${noun} for my team`}
              className='mt-1.5 w-full resize-y rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-800 placeholder:text-slate-400 focus:border-nvr-cyan focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30 dark:border-border dark:bg-background dark:text-slate-100'
              data-request-access-note
            />
            <p className='mt-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
              Every administrator gets your request with this {noun} and your note.
            </p>
          </div>
        )}

        {!notFound && !isLoading && (
          <button
            type='button'
            disabled={requested || requestAccess.isPending}
            onClick={() => requestAccess.mutate()}
            className='mt-3 inline-flex items-center gap-1.5 rounded-md bg-nvr-cyan px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50'
            data-request-access
          >
            {requested ? (
              <>
                <Check className='h-3.5 w-3.5' /> Request sent
              </>
            ) : (
              <>
                <Send className='h-3.5 w-3.5' />
                {requestAccess.isPending ? 'Sending…' : 'Request access'}
              </>
            )}
          </button>
        )}

        {onBack && (
          <button
            type='button'
            onClick={onBack}
            className='mt-5 inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-white/[0.03]'
          >
            <ArrowLeft className='h-3.5 w-3.5' />
            Go back
          </button>
        )}
      </div>
    </div>
  )
}
