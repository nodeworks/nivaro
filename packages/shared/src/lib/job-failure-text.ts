import { describeError } from './error-message'
import { partnerCallText } from './partner-failure'
import { isRawErrorText } from './safe-error'

/**
 * What the Jobs tray says for a job that failed. A job's stored error is written for the
 * log. A move another system refused is read the way its row and its toast read it (the
 * other system's own words, or what the failure means about that system); any other raw
 * text (a status line, SQL, a stack) is read like every other error; plain words show as
 * they are. Null when there is nothing to say.
 */
export function jobFailureText(error: string | null | undefined): string | null {
  const text = (error ?? '').trim()
  if (!text) return null
  const partner = partnerCallText(text)
  if (partner) return partner
  if (!isRawErrorText(text)) return text
  return (
    describeError({ message: text }, 'This did not finish').title.trim() || 'This did not finish'
  )
}
