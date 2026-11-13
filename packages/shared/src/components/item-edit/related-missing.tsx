import { useQuery } from '@tanstack/react-query'
import { useOptionalNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { describeError } from '../../lib/error-message'
import { cn } from '../../lib/utils'

/**
 * What a linked record's label says when its row could not be read. Never
 * the raw id (army8 b01 "Find a Unit 273025"), and never a permissions
 * sentence for a row that is simply gone or a read that failed (army8
 * review M8: a deleted link read as "Not available to you" to its creator).
 *
 * The API answers 404 both for a row that no longer exists and for one the
 * reader's access hides (it never says which), so a 404 is worded to cover
 * both; only a refusal (403) or an empty answer is about access. A label
 * that knows which record it stands for asks the server which of the two it
 * is (useRelatedMissing) and says that instead.
 */
export type RelatedMissingKind = 'no-access' | 'not-found' | 'failed'

export interface RelatedMissing {
  kind: RelatedMissingKind
  text: string
  tip: string
}

export function relatedMissing(error: unknown): RelatedMissing {
  if (error == null)
    return {
      kind: 'no-access',
      text: 'Not available to you',
      tip: 'Your access does not include this record.'
    }
  const kind = describeError(error).kind
  if (kind === 'forbidden' || kind === 'signed-out')
    return {
      kind: 'no-access',
      text: 'Not available to you',
      tip: 'Your access does not include this record.'
    }
  if (kind === 'not-found')
    return {
      kind: 'not-found',
      text: 'Record not found',
      tip: 'It may have been deleted, or it is outside what you can see.'
    }
  return {
    kind: 'failed',
    text: 'Couldn’t load',
    tip: 'The linked record didn’t load. Reload the page to try again.'
  }
}

/** A read that will answer the same way again (gone / refused) is not retried. */
export function retryRelatedRead(failures: number, error: unknown): boolean {
  if (relatedMissing(error).kind !== 'failed') return false
  return failures < 2
}

/** GET /access-explain's answer: which gate hid the record, or that it is gone. */
export interface AccessExplainAnswer {
  access: boolean
  reasons: Array<{ type: string; message?: string }>
}

/**
 * The wording for a 404 once the server has said which it was. A record a
 * gate hides (User Scope, row rule, role) is "Not available to you" with the
 * server's own sentence as the hint; one that does not exist stays "Record
 * not found". Null when the answer settles nothing (no answer, or the server
 * says the reader can see it — the read failed for another reason).
 */
export function explainedMissing(
  answer: AccessExplainAnswer | null | undefined
): RelatedMissing | null {
  const reasons = answer?.reasons ?? []
  if (reasons.length === 0) return null
  const gone = reasons.find((r) => r.type === 'not_found')
  if (gone)
    return {
      kind: 'not-found',
      text: 'Record not found',
      // The server's sentence says when it was deleted, by whom and that it
      // can be restored: more use than a fixed "was removed".
      tip: gone.message?.trim() || 'This record was removed.'
    }
  const said = reasons.find((r) => r.message?.trim())?.message?.trim()
  return {
    kind: 'no-access',
    text: 'Not available to you',
    tip: said ?? 'Your access does not include this record.'
  }
}

/** System tables are never explained (the route refuses them). */
const SYSTEM_TABLE = /^(nivaro|directus)_/i

/**
 * relatedMissing, made exact for a 404 when the label knows its record: one
 * read of /access-explain says whether the row is hidden from the reader or
 * gone. `settling` is true while that read is out, so the label can wait
 * instead of showing one wording and then another. A refusal, a failed load
 * and a label with no record to ask about are answered at once, unchanged.
 */
export function useRelatedMissing(
  error: unknown,
  collection?: string | null,
  id?: unknown
): { missing: RelatedMissing; settling: boolean } {
  const client = useOptionalNivaroClient()
  const base = relatedMissing(error)
  const ask =
    !!client &&
    base.kind === 'not-found' &&
    !!collection &&
    !SYSTEM_TABLE.test(collection) &&
    id != null &&
    id !== ''
  const { data, isLoading } = useQuery<AccessExplainAnswer | null>({
    // Its own key: the denied panel keeps a differently shaped answer for a
    // record page under 'access-explain'.
    queryKey: ['related-missing-explain', collection, String(id)],
    queryFn: () =>
      (client as NonNullable<typeof client>)
        .request<{ data: AccessExplainAnswer | null }>(
          get(`/access-explain/${collection}/${encodeURIComponent(String(id))}`)
        )
        .then((r) => r.data ?? null)
        // No answer is not an error the person can act on: the 404 wording stands.
        .catch(() => null),
    enabled: ask,
    staleTime: 5 * 60_000,
    retry: false
  })
  if (!ask) return { missing: base, settling: false }
  return { missing: explainedMissing(data) ?? base, settling: isLoading }
}

/**
 * The placeholder a linked record's label shows while its row is being read
 * (the read view), and while the label asks which kind of missing it is: one
 * look for the whole wait, not a second skeleton of another width and tone.
 */
export const RELATED_LOADING_CLASS =
  'inline-block h-3.5 w-20 animate-pulse rounded bg-slate-100 align-middle dark:bg-[hsl(var(--nvr-skeleton))]'

export function RelatedMissingLabel({
  error,
  collection,
  id,
  className,
  settlingClassName = RELATED_LOADING_CLASS,
  labelId
}: {
  error: unknown
  /** The linked record, when known: lets a 404 say "hidden from you" or "removed". */
  collection?: string | null
  id?: unknown
  className?: string
  /** The placeholder shown while the reason is asked for; the read view's by default. */
  settlingClassName?: string
  /** DOM id for the words. A control beside them (the picker's "Change") names
   *  it as its description, and the reason then rides inside for a screen
   *  reader: the tip alone only reaches a mouse. */
  labelId?: string
}) {
  const { missing: m, settling } = useRelatedMissing(error, collection, id)
  if (settling)
    return (
      <span aria-hidden='true' data-related-unavailable-settling='' className={settlingClassName} />
    )
  return (
    <span
      id={labelId}
      // `relative` keeps the hidden reason anchored to these words (an sr-only
      // element is absolute and would otherwise anchor to the page).
      className={cn('italic text-muted-foreground', labelId && 'relative', className)}
      data-related-unavailable={m.kind}
      // The words too: a narrow grid cell cuts them to "Not availa…", and the
      // tip is then the only place the whole of it can be read.
      data-tip={`${m.text}. ${m.tip}`}
    >
      {m.text}
      {labelId && <span className='sr-only'>. {m.tip}</span>}
    </span>
  )
}
