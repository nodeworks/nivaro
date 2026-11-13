import { partnerFailureText, withoutMoveLabel } from './partner-failure'
import { serverErrorText } from './safe-error'

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
  if (!said) return null
  const description = partnerFailureText(withoutMoveLabel(said, label))
  if (!description) return null
  return { title: `${label?.trim() || 'The move'} did not go through`, description }
}
