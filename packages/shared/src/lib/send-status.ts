import { describeError } from './error-message'
import { partnerOutcome, partnerSaid, partnerWords } from './partner-failure'
import { getDisplayTimezone } from './utils'

/**
 * Where a record's latest send to a partner stands, in words that say exactly what
 * happened (rt4 #10). The facts come from GET /erp-submissions/send-status (api
 * services/send-status.ts); one fact = the newest send to one partner.
 *
 * States, in the order a send goes through them:
 *   sending    "Sending to Ledger now (started 10:42 AM)"
 *   waiting    "Sent to Ledger at 10:42 AM — waiting for Ledger's answer"
 *              (+ " · usually answers within 4 minutes" only from real history)
 *   accepted   "Ledger accepted it at 10:43 AM — PO 12345" (the API's reference label;
 *              "reference" when none is set)
 *   refused    "Ledger refused it at 10:43 AM: The project is closed. Fix what it names,
 *              then send it again."
 *   not_taken  "Couldn't reach Ledger — nothing was sent. Retrying at 10:45 AM (attempt 2
 *              of 5)" when a sweep will try again (rt6 #18), else "… Try again or ask an
 *              admin." (the call did not get through, or the partner was down: nothing was
 *              refused); "Ledger was too busy to take it at 10:43 AM — nothing was sent. …"
 *   no_answer  "No answer from Ledger after 25 minutes — the send is held and will not be
 *              repeated automatically"
 *
 * A failed send nothing will repeat says why on a quieter line (`detail`):
 * "Will not retry — automatic retries are not set up for Ledger".
 *
 * There is no "queued" state: a send runs as part of its move, in parallel across
 * records, never behind other records' sends — so no position is ever shown.
 */

export interface SendStatusFact {
  id: number
  api: string
  /** sending | pending | accepted | failed | rejected */
  status: string
  started_at: string
  finished_at: string | null
  external_ref: string | null
  /** transient | rate_limited | auth | not_found | validation | unknown | null */
  error_class: string | null
  reason: string | null
  answer_by: string | null
  usual_answer_ms: number | null
  /** What this partner calls its number ("PO", "order"); null/absent = "reference". */
  ref_label?: string | null
  /** rt6 #18 — a sweep will try this failed send again by itself. */
  retry?: { at: string; attempt: number; of: number } | null
  /** rt6 #18 — nothing will repeat this failed send: why. */
  no_retry?: string | null
}

export type SendState = 'sending' | 'waiting' | 'accepted' | 'refused' | 'not_taken' | 'no_answer'

export interface SendStatusWords {
  state: SendState
  text: string
  /** busy = in flight, waiting = with the partner (or a retry is coming), ok, problem, held */
  tone: 'busy' | 'waiting' | 'ok' | 'problem' | 'held'
  /** A quieter second line: why a failed send will not be tried again by itself. */
  detail?: string
  /** When the automatic retry is due (ISO) — the record line counts down to it. */
  retry_at?: string
}

/** "10:42 AM" today, "Nov 12, 10:42 AM" another day (the viewer's display time zone). */
export function atClock(at: string | number | Date, now: number = Date.now()): string {
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const tz = getDisplayTimezone()
  const zone = tz ? { timeZone: tz } : {}
  const day = (x: Date) =>
    new Intl.DateTimeFormat('en-US', {
      ...zone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    }).format(x)
  const time = new Intl.DateTimeFormat('en-US', {
    ...zone,
    hour: 'numeric',
    minute: '2-digit'
  }).format(d)
  if (day(d) === day(new Date(now))) return time
  const date = new Intl.DateTimeFormat('en-US', { ...zone, month: 'short', day: 'numeric' }).format(
    d
  )
  return `${date}, ${time}`
}

/** "less than a minute", "1 minute", "25 minutes", "3 hours", "2 days". */
export function plainDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return 'less than a minute'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.round(ms / 3_600_000)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(ms / 86_400_000)
  return `${days} day${days === 1 ? '' : 's'}`
}

/** The partner's reason in plain words: its own sentence when it gave one, else what it means. */
export function plainSendReason(reason: string | null | undefined): string {
  const text = (reason ?? '').trim()
  if (!text) return ''
  // The partner's own sentence first; else what the failure means; else its plain reading.
  // ("Submission failed — HTTP 400: …" — the lead is ours, the sentence already says refused.)
  const mark = /\bHTTP \d{3}: /.exec(text)
  const said =
    partnerWords(mark ? text.slice(mark.index) : text) ?? partnerOutcome(text) ?? partnerSaid(text)
  if (said) return said.replace(/[\s.,;:]+$/, '')
  return describeError({ message: text }, '').title.replace(/[\s.,;:]+$/, '')
}

export interface SendWordsOptions {
  now?: number
  /** Formats a moment (default atClock). Tests pass a fixed one. */
  time?: (iso: string) => string
  /** Reads a stored reason (default plainSendReason). */
  reason?: (raw: string | null) => string
}

/** Classes where the partner took no decision: the call failed, or it was down or busy. */
const NOT_TAKEN = new Set(['transient', 'rate_limited'])

/** What one send's state is, and the sentence that says it. */
export function sendStatusWords(f: SendStatusFact, opts: SendWordsOptions = {}): SendStatusWords {
  const now = opts.now ?? Date.now()
  const time = opts.time ?? ((iso: string) => atClock(iso, now))
  const readReason = opts.reason ?? plainSendReason
  const p = f.api?.trim() || 'the other system'
  const status = (f.status ?? '').toLowerCase()
  const doneAt = f.finished_at ?? f.started_at

  if (status === 'sending') {
    const deadline = f.answer_by ? new Date(f.answer_by).getTime() : Number.NaN
    if (Number.isFinite(deadline) && now > deadline)
      return {
        state: 'no_answer',
        tone: 'held',
        text: `No answer from ${p} after ${plainDuration(now - new Date(f.started_at).getTime())} — the send is held and will not be repeated automatically`
      }
    return {
      state: 'sending',
      tone: 'busy',
      text: `Sending to ${p} now (started ${time(f.started_at)})`
    }
  }
  if (status === 'pending') {
    const usual =
      f.usual_answer_ms != null && f.usual_answer_ms > 0
        ? ` · usually answers within ${plainDuration(f.usual_answer_ms)}`
        : ''
    return {
      state: 'waiting',
      tone: 'waiting',
      text: `Sent to ${p} at ${time(f.started_at)} — waiting for ${p}'s answer${usual}`
    }
  }
  if (status === 'accepted') {
    const ref = f.external_ref?.trim()
    const label = f.ref_label?.trim() || 'reference'
    return {
      state: 'accepted',
      tone: 'ok',
      text: `${p} accepted it at ${time(doneAt)}${ref ? ` — ${label} ${ref}` : ''}`
    }
  }
  // failed / rejected
  const cls = (f.error_class ?? '').toLowerCase()
  const why = readReason(f.reason)
  const retry = f.retry && f.retry.at ? f.retry : null
  const retryAt = retry ? new Date(retry.at).getTime() : Number.NaN
  const retryText = retry
    ? `${Number.isFinite(retryAt) && retryAt > now ? `Retrying at ${time(retry.at)}` : 'Retrying now'} (attempt ${retry.attempt} of ${retry.of})`
    : ''
  const extra = (): Pick<SendStatusWords, 'detail' | 'retry_at'> =>
    retry
      ? { retry_at: retry.at }
      : f.no_retry?.trim()
        ? { detail: `Will not retry — ${f.no_retry.trim()}` }
        : {}
  if (NOT_TAKEN.has(cls)) {
    const busy = cls === 'rate_limited'
    const lead = busy
      ? `${p} was too busy to take it at ${time(doneAt)} — nothing was sent.`
      : `Couldn't reach ${p} — nothing was sent.`
    const next = retry
      ? retryText
      : busy
        ? 'Try again in a few minutes.'
        : 'Try again or ask an admin.'
    return {
      state: 'not_taken',
      tone: retry ? 'waiting' : 'problem',
      text: `${lead} ${next}`,
      ...extra()
    }
  }
  const refused = `${p} refused it at ${time(doneAt)}`
  if (cls === 'auth')
    return {
      state: 'refused',
      tone: retry ? 'waiting' : 'problem',
      text: `${refused}: it did not accept this app's sign-in. ${
        retry ? retryText : `An administrator needs to check the connection to ${p}.`
      }`,
      ...extra()
    }
  return {
    state: 'refused',
    tone: retry ? 'waiting' : 'problem',
    text: `${refused}${why ? `: ${why}` : ''}. ${retry ? retryText : 'Fix what it names, then send it again.'}`,
    ...extra()
  }
}

/** "in 6 minutes" to an upcoming retry (whole minutes, rounded up), or null once it is due. */
export function retryCountdown(
  at: string | undefined | null,
  now: number = Date.now()
): string | null {
  if (!at) return null
  const t = new Date(at).getTime()
  if (!Number.isFinite(t) || t <= now) return null
  const mins = Math.ceil((t - now) / 60_000)
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`
  return `in ${plainDuration(t - now)}`
}

/** The ms until an upcoming retry's countdown next changes (a minute boundary or the retry), or null. */
export function msUntilRetryTick(f: SendStatusFact, now: number = Date.now()): number | null {
  const at = f.retry?.at ? new Date(f.retry.at).getTime() : Number.NaN
  if (!Number.isFinite(at) || at <= now) return null
  const left = at - now
  return Math.min(left, ((left - 1) % 60_000) + 1) + 250
}

/** The ms until a `sending` fact turns into "no answer" by itself (no write marks it), or null. */
export function msUntilNoAnswer(f: SendStatusFact, now: number = Date.now()): number | null {
  if ((f.status ?? '').toLowerCase() !== 'sending' || !f.answer_by) return null
  const at = new Date(f.answer_by).getTime()
  if (!Number.isFinite(at) || at < now) return null
  return at - now + 500
}
