import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeft, Check, Lock, Send } from 'lucide-react'
import { type ReactNode, useState } from 'react'
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

/** The lock card both refusals share: one heading, one plain line under it, then the way on. */
function DeniedCard({
  title,
  subtitle,
  children
}: {
  title: string
  subtitle: string
  children?: ReactNode
}) {
  return (
    <div className='flex flex-1 items-start justify-center px-4 py-10 sm:px-6 sm:py-16'>
      <div
        className='w-full max-w-[560px] rounded-xl border border-slate-200 bg-white p-5 sm:p-8 dark:border-border dark:bg-card'
        data-access-denied
      >
        <div className='flex items-start gap-3'>
          <span className='flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-muted'>
            <Lock className='h-[18px] w-[18px] text-slate-500 dark:text-slate-400' aria-hidden />
          </span>
          <div className='min-w-0 pt-0.5'>
            <h2 className='text-[15px] font-semibold text-slate-800 dark:text-slate-100'>
              {title}
            </h2>
            <p className='mt-0.5 text-[12.5px] leading-snug text-slate-600 dark:text-slate-400'>
              {subtitle}
            </p>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

/** "Need it? Say what for" + Request access (+ Go back on the same row). */
function RequestAccess({
  collection,
  itemId,
  noun,
  placeholder,
  onBack
}: {
  collection: string
  itemId?: string
  noun: string
  placeholder: string
  onBack?: () => void
}) {
  const client = useNivaroClient()
  const [requested, setRequested] = useState(false)
  // Army 11: the person may say why — the administrator used to read only a canned sentence.
  const [note, setNote] = useState('')
  const requestAccess = useMutation({
    mutationFn: () =>
      client.request(
        post('/access-requests', {
          collection,
          ...(itemId ? { item: String(itemId) } : {}),
          ...(note.trim() ? { note: note.trim().slice(0, NOTE_MAX) } : {})
        })
      ),
    onSuccess: () => {
      setRequested(true)
      toast.success('Access request sent — an administrator has been notified')
    },
    onError: () => toast.error('Could not send the request')
  })
  const noteId = `access-note-${collection}-${itemId ?? 'list'}`
  return (
    <>
      {!requested && (
        <div className='mt-5'>
          <label
            htmlFor={noteId}
            className='block text-[12px] font-medium text-slate-700 dark:text-slate-300'
          >
            Need it? Say what for{' '}
            <span className='font-normal text-slate-500 dark:text-slate-400'>(optional)</span>
          </label>
          <textarea
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
            rows={2}
            maxLength={NOTE_MAX}
            placeholder={placeholder}
            className='mt-1.5 w-full resize-y rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-800 placeholder:text-slate-500 focus:border-nvr-cyan focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30 dark:border-border dark:bg-background dark:text-slate-100 dark:placeholder:text-slate-500'
            data-request-access-note
          />
          <p className='mt-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
            Every administrator gets your request with this {noun} and your note.
          </p>
        </div>
      )}
      <div className='mt-3 flex flex-wrap items-center gap-2'>
        <button
          type='button'
          disabled={requested || requestAccess.isPending}
          onClick={() => requestAccess.mutate()}
          className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-60'
          data-request-access
        >
          {requested ? (
            <>
              <Check className='h-3.5 w-3.5' aria-hidden /> Request sent
            </>
          ) : (
            <>
              <Send className='h-3.5 w-3.5' aria-hidden />
              {requestAccess.isPending ? 'Sending…' : 'Request access'}
            </>
          )}
        </button>
        {onBack && <BackButton onBack={onBack} />}
      </div>
    </>
  )
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type='button'
      onClick={onBack}
      className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-white/[0.04]'
    >
      <ArrowLeft className='h-3.5 w-3.5' aria-hidden />
      Go back
    </button>
  )
}

/**
 * Words for a refused record. One explanation only (rt4 review): with the server's reasons the
 * card says "You can't view this …" and lists them; when the cause is unknown (the explain read
 * failed) it says so once — deleted or out of reach — instead of claiming "outside your access"
 * and then doubting it in a second box. Exported for tests.
 */
export function deniedWording(
  noun: string,
  reasons: AccessReason[] | null
): { title: string; subtitle: string; kind: 'not_found' | 'denied' | 'unknown' } {
  const Noun = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`
  if (reasons?.some((r) => r.type === 'not_found'))
    return {
      kind: 'not_found',
      title: `${Noun} not found`,
      subtitle: 'The link may be wrong, or it was removed.'
    }
  if (reasons && reasons.length > 0)
    return {
      kind: 'denied',
      title: `You can't view this ${noun}`,
      subtitle: 'It is outside what your access lets you see.'
    }
  return {
    kind: 'unknown',
    title: `This ${noun} could not be opened`,
    subtitle: 'It may have been deleted, or your access may not reach it.'
  }
}

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

  if (isLoading)
    return (
      <div className='flex flex-1 items-start justify-center px-4 py-10 sm:px-6 sm:py-16'>
        <div className='w-full max-w-[560px] space-y-2.5 rounded-xl border border-slate-200 bg-white p-5 sm:p-8 dark:border-border dark:bg-card'>
          <div className='h-4 w-1/2 animate-pulse rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
          <div className='h-4 w-3/4 animate-pulse rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
        </div>
      </div>
    )

  const reasons = data?.reasons ?? null
  const words = deniedWording(noun, reasons)

  return (
    <DeniedCard title={words.title} subtitle={words.subtitle}>
      {words.kind === 'denied' && reasons && (
        <div className='mt-5 space-y-2'>
          {reasons.map((r, i) => (
            <div
              key={`${r.type}-${r.dimension ?? i}`}
              className='rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-300'
            >
              {r.message}
            </div>
          ))}
        </div>
      )}
      {words.kind === 'not_found' ? (
        onBack && (
          <div className='mt-5'>
            <BackButton onBack={onBack} />
          </div>
        )
      ) : (
        <RequestAccess
          collection={collection}
          itemId={itemId}
          noun={noun}
          placeholder={`e.g. I approve this ${noun} for my team`}
          onBack={onBack}
        />
      )}
    </DeniedCard>
  )
}

/**
 * A list the person may not read (rt4 review): the same lock card as a refused record, in place
 * of the grid, filters and totals — "You can't see Workflows" + Request access — instead of a
 * red "You do not have access to do this" bar above an empty table.
 */
export function ListAccessDenied({
  collection,
  label,
  onBack
}: {
  collection: string
  /** The list's plural label ("Workflows"). */
  label: string
  onBack?: () => void
}) {
  return (
    <DeniedCard title={`You can't see ${label}`} subtitle='Your access does not include this list.'>
      <RequestAccess
        collection={collection}
        noun='list'
        placeholder={`e.g. I review ${label.toLowerCase()} for my team`}
        onBack={onBack}
      />
    </DeniedCard>
  )
}
