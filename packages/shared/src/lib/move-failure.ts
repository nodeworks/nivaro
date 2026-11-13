import { partnerFailureText, withoutMoveLabel } from './partner-failure'
import { serverErrorText } from './safe-error'

/** What the API answers for a move whose own call to another system failed. */
const PARTNER_CALL = /(?:^|: )submission failed\s+[—–-]\s/i

/**
 * The toast for a move another system refused, pressed the ordinary way: the move by name,
 * and under it what the other system answered in its own words (or, when its answer held
 * no sentence, what the failure means about that system). The same words the row for a
 * background move shows, so the two never disagree.
 *
 * Null for every other failure (a check's refusal, an access refusal, a network error): the
 * caller's usual toast stands. The status line itself is never part of what is returned.
 */
export function partnerMoveFailure(
  err: unknown,
  label: string | null | undefined
): { title: string; description: string } | null {
  const said = serverErrorText(err)
  // Only a move's own call to another system, which the API answers as
  // "<move>: submission failed — <what happened>". A fault of this app's own (a 500 whose
  // text names a socket error or a status) is not the other system's: it keeps its toast.
  if (!said || !PARTNER_CALL.test(said)) return null
  const description = partnerFailureText(withoutMoveLabel(said, label))
  if (!description) return null
  return { title: `${label?.trim() || 'The move'} did not go through`, description }
}
