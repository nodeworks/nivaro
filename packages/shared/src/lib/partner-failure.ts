/**
 * A move that calls another system (a warehouse, an ERP) and fails is stored, and answered,
 * as a status line with an excerpt of the other system's answer:
 * 'Submission failed — HTTP 400: "The project is not valid"'. Read like any other error,
 * the status line hid the one sentence the person needs, or was read as the person's own
 * request ("You've been signed out", "Some values need fixing").
 *
 * These read it as what it is. Used by the row for a background move that did not go
 * through (components/panels/BackgroundMove.tsx) and by the toast of a move pressed the
 * ordinary way (./move-failure.ts), so the two say the same thing.
 */
import { isRawErrorText } from './safe-error'

/**
 * A stored reason without the move's own name in front of it ("Submit: submission failed —
 * …" → "Submission failed — …"), whatever the name's letter case.
 */
export function withoutMoveLabel(
  reason: string | null | undefined,
  label: string | null | undefined
): string {
  const text = (reason ?? '').trim()
  const name = (label ?? '').trim()
  const rest =
    name && text.toLowerCase().startsWith(`${name.toLowerCase()}:`)
      ? text.slice(name.length + 1).trim()
      : text
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : ''
}

/** The status line a partner call's failure is stored with: "… — HTTP 400: <body excerpt>". */
const STATUS_MARK = /\bHTTP \d{3}: /
/** Where a partner's answer keeps its sentence, most telling first. */
const WORD_KEYS = [
  'message',
  'error_description',
  'detail',
  'error',
  'title',
  'reason',
  'description',
  'msg'
]
const KEYED_SENTENCE = new RegExp(`"(?:${WORD_KEYS.join('|')})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`)

/** A JSON string's inner text as the text it stands for (a body cut short may end mid-escape). */
function unescapeJson(inner: string): string {
  try {
    return JSON.parse(`"${inner.replace(/\\$/, '')}"`) as string
  } catch {
    return inner
  }
}

function sentenceIn(value: unknown, depth = 0): string | null {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 1) return null
  const body = value as Record<string, unknown>
  for (const key of WORD_KEYS) {
    const found = sentenceIn(body[key], depth + 1)
    if (found?.trim()) return found
  }
  return null
}

/**
 * What the other system answered, in its own words, when a stored reason is a
 * partner call's failure ("Submission failed — HTTP 400: "The project is not
 * valid""). Those words are what the person needs to put the request right, so
 * the row shows them: "Submission failed: The project is not valid". Only words:
 * the status line itself is never shown, and an answer that reads as anything
 * else (markup, a stack, SQL, an id) gives null, so the reason is read the usual
 * way. The body is an excerpt and may be cut short.
 */
export function partnerWords(reason: string): string | null {
  const mark = STATUS_MARK.exec(reason)
  if (!mark) return null
  const body = reason.slice(mark.index + mark[0].length).trim()
  let words: string | null = null
  // The sentence did not end where it stops: the stored body was cut inside it.
  let cut = false
  try {
    words = sentenceIn(JSON.parse(body))
  } catch {
    // Cut short: the sentence under a known key, else a body that is one (unfinished) string.
    const keyed = KEYED_SENTENCE.exec(body)
    if (keyed) {
      words = unescapeJson(keyed[1])
      cut = body[keyed.index + keyed[0].length] !== '"'
    } else if (body.startsWith('"')) {
      words = unescapeJson(body.slice(1).replace(/"$/, ''))
      cut = body.length < 2 || !body.endsWith('"')
    }
  }
  const full = (words ?? '').replace(/\s+/g, ' ').trim()
  // A cut sentence says so: it must never just stop mid-word as if that were all of it.
  const said = cut || full.length > 300 ? `${full.slice(0, 299).trimEnd()}…` : full
  // Judged on the sentence itself, before the mark: "Bad Request…" is still a status phrase.
  if (full.length < 3 || /<[a-z!/]/i.test(full) || isRawErrorText(full)) return null
  const lead = reason
    .slice(0, mark.index)
    .replace(/[\s:·—–-]+$/, '')
    .trim()
  return lead ? `${lead}: ${said}` : said
}

/** The other system's status anywhere in a stored reason: "… — HTTP 502: …", "… (HTTP 401): …". */
const PARTNER_STATUS = /\bHTTP (\d{3})\b/
/** A call that got no answer at all, in Node's and the API's own words. */
const NO_ANSWER =
  /\b(?:fetch failed|Timed out after \d+ms|socket hang up|E(?:CONN[A-Z]+|NOTFOUND|AI_AGAIN|TIMEDOUT|HOSTUNREACH))\b/

/**
 * What a partner call's failure means when its answer held no words a person can
 * read. Said about the other system: the sentences every other error is read with
 * are about the person's own request ("You've been signed out", "Someone else
 * changed this"), and here the status is the other system's answer to this app.
 * Null for a reason that is not a partner call's failure.
 */
export function partnerOutcome(reason: string): string | null {
  const status = Number(PARTNER_STATUS.exec(reason)?.[1] ?? 0)
  if (!status) {
    if (!NO_ANSWER.test(reason)) return null
    return /Timed out after|ETIMEDOUT/.test(reason)
      ? 'The other system took too long to answer.'
      : 'The other system could not be reached.'
  }
  if (status === 401 || status === 403)
    return 'The other system did not accept this app’s sign-in. An administrator needs to check the connection.'
  if (status === 408 || status === 504) return 'The other system took too long to answer.'
  if (status === 502 || status === 503) return 'The other system is not answering right now.'
  if (status >= 500) return 'The other system ran into a problem of its own.'
  return 'The other system refused the request.'
}

/** A partner call's failure in the other system's words, else what it means about that system. */
export function partnerFailureText(reason: string): string | null {
  return partnerWords(reason) ?? partnerOutcome(reason)
}

/** What the API stores and answers for a move whose own call to another system failed:
 *  "<move>: submission failed — <what happened>". */
const PARTNER_CALL = /(?:^|: )submission failed\s+[—–-]\s/i

/**
 * The reading of a text of that one shape, without the move's name in front of it; null for
 * any other text. A fault of this app's own (a 500 whose text names a socket error or a
 * status) is not the other system's and is never read as one.
 */
export function partnerCallText(text: string): string | null {
  const shape = PARTNER_CALL.exec(text)
  if (!shape) return null
  // From "submission failed" on: the move's own name in front of it is the caller's to say.
  const rest = text.slice(shape.index + (shape[0].startsWith(': ') ? 2 : 0))
  return partnerFailureText(rest.charAt(0).toUpperCase() + rest.slice(1))
}
