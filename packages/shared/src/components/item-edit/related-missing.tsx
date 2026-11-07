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
 * both; only a refusal (403) or an empty answer is about access.
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

export function RelatedMissingLabel({ error, className }: { error: unknown; className?: string }) {
  const m = relatedMissing(error)
  return (
    <span
      className={cn('italic text-muted-foreground', className)}
      data-related-unavailable={m.kind}
      data-tip={m.tip}
    >
      {m.text}
    </span>
  )
}
