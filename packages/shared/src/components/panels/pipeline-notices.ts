import { withoutMoveLabel } from '../../lib/partner-failure'
import { atClock, type SendStatusFact, sendReason, sendStatusWords } from '../../lib/send-status'
import { serverNow } from '../../lib/server-clock'
import type { MoveProblem } from './BackgroundMove'

/**
 * One failed automatic push used to show as three blocks on the record's pipeline row
 * (Rob 2026-11-18, "a lot of repetitive information here"):
 *
 *   1. the background move that did not move the record (`last_move_problem`, BackgroundMove.tsx)
 *   2. the record's latest send to that partner, refused (`send-status`, SendStatus.tsx)
 *   3. the automatic transition the engine stopped re-firing (`auto_held`, #1217)
 *
 * all three quoting the partner's same sentence. They are one event when they are about the
 * same transition / push within the same few minutes; this file decides that, and says the
 * event once: what failed, the partner's reason (quoted once), when, and what to do.
 * Events that are genuinely different stay separate notices.
 */

/** Automatic transitions the engine stopped re-firing (#1217): their push was refused and
 *  nothing they would send has changed since. */
export interface HeldAutoTransition {
  transition_id: string
  transition_label: string | null
  error_class: string | null
  error: string | null
  attempts: number
  first_failed_at: string
  last_failed_at: string
  retry_at: string | null
}

/** Two records of one failure land within this of each other (a run finishes, its send is
 *  stored and the engine remembers it in the same moment; a retry ladder step is minutes). */
export const SAME_EVENT_WINDOW_MS = 15 * 60_000

/** One failure as the record's pipeline row says it. At least one part is set. */
export interface PipelineEvent {
  problem: MoveProblem | null
  held: HeldAutoTransition | null
  send: SendStatusFact | null
}

export interface ComposedNotices {
  /** In order: the last run's problem first, then automatic moves held on their own. */
  events: PipelineEvent[]
  /** Sends a notice already speaks for: the send-status lines leave them out. */
  spokenSendIds: number[]
}

const ms = (iso: string | null | undefined): number => {
  const t = iso ? new Date(iso).getTime() : Number.NaN
  return Number.isFinite(t) ? t : Number.NaN
}
const sameId = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toUpperCase() === b.toUpperCase()

const FAILED = new Set(['failed', 'rejected'])

/** When a part of an event happened (its end, where it has one). */
function problemAt(p: MoveProblem): number {
  return ms(p.finished_at ?? p.started_at)
}
function sendAt(f: SendStatusFact): number {
  return ms(f.finished_at ?? f.started_at)
}

/** The partner's own sentence in a stored reason, lower-cased, for comparing. */
function partnerSentence(raw: string | null | undefined, label: string | null): string {
  const r = sendReason(withoutMoveLabel(raw, label))
  return r.quoted ? r.text.toLowerCase() : ''
}

/** A held auto transition is the problem's transition and failed while the problem did. */
function heldMatchesProblem(h: HeldAutoTransition, p: MoveProblem): boolean {
  if (!sameId(h.transition_id, p.transition_id)) return false
  const at = problemAt(p)
  const first = ms(h.first_failed_at)
  const last = ms(h.last_failed_at)
  if (!Number.isFinite(at)) return true
  const lo = Number.isFinite(first) ? first : last
  const hi = Number.isFinite(last) ? last : first
  if (!Number.isFinite(lo)) return true
  return at >= lo - SAME_EVENT_WINDOW_MS && at <= hi + SAME_EVENT_WINDOW_MS
}

/**
 * A failed send is this event's push: it failed within the window and names the same
 * partner (the move's label or stored reason carries the partner's name, or both quote the
 * partner's same sentence).
 */
function sendScore(f: SendStatusFact, ev: PipelineEvent): number | null {
  if (!FAILED.has((f.status ?? '').toLowerCase())) return null
  const label = ev.problem?.transition_label ?? ev.held?.transition_label ?? null
  const raws = [ev.problem?.reason, ev.held?.error].filter((r): r is string => !!r)
  const times = [
    ev.problem ? problemAt(ev.problem) : Number.NaN,
    ev.held ? ms(ev.held.last_failed_at) : Number.NaN
  ].filter(Number.isFinite)
  const at = sendAt(f)
  if (!Number.isFinite(at) || times.length === 0) return null
  const gap = Math.min(...times.map((t) => Math.abs(t - at)))
  if (gap > SAME_EVENT_WINDOW_MS) return null
  const api = (f.api ?? '').trim().toLowerCase()
  const said = partnerSentence(f.reason, null)
  const hay = [label ?? '', ...raws].join(' ').toLowerCase()
  const named = api.length >= 2 && hay.includes(api)
  const sameWords = !!said && raws.some((r) => partnerSentence(r, label) === said)
  return named || sameWords ? gap : null
}

/**
 * Which notices the record's pipeline row shows for these facts. Pure: the panel feeds it
 * what the pipeline read and the send-status read answered.
 */
export function composePipelineNotices(input: {
  problem: MoveProblem | null | undefined
  held: HeldAutoTransition[] | null | undefined
  sends: SendStatusFact[] | null | undefined
}): ComposedNotices {
  const problem = input.problem ?? null
  const held = Array.isArray(input.held) ? input.held : []
  const sends = Array.isArray(input.sends) ? input.sends : []
  const spoken = new Set<number>()
  // The run's send that never got an answer is its own row's business (BackgroundMove.tsx).
  const unansweredId = problem?.unanswered?.submission_id ?? null
  if (unansweredId != null) spoken.add(unansweredId)

  const events: PipelineEvent[] = []
  const usedHeld = new Set<HeldAutoTransition>()
  if (problem) {
    const h = problem.unanswered ? null : (held.find((x) => heldMatchesProblem(x, problem)) ?? null)
    if (h) usedHeld.add(h)
    events.push({ problem, held: h, send: null })
  }
  for (const h of held) if (!usedHeld.has(h)) events.push({ problem: null, held: h, send: null })

  // Each failed send speaks for at most one event, the one closest in time.
  for (const ev of events) {
    if (ev.problem?.unanswered) continue
    let best: { f: SendStatusFact; gap: number } | null = null
    for (const f of sends) {
      if (spoken.has(f.id)) continue
      const gap = sendScore(f, ev)
      if (gap != null && (!best || gap < best.gap)) best = { f, gap }
    }
    if (best) {
      ev.send = best.f
      spoken.add(best.f.id)
    }
  }
  return { events, spokenSendIds: [...spoken] }
}

/** True when the event is a plain run problem the existing row already says well alone. */
export function isPlainProblem(ev: PipelineEvent): boolean {
  return !!ev.problem && !ev.held && !ev.send
}

const ERROR_CLASS_TEXT: Record<string, string> = {
  validation: 'The other system refused what was sent',
  not_found: 'The other system could not find what was referred to',
  auth: 'The other system did not accept this app’s sign-in',
  transient: 'The other system could not be reached',
  rate_limited: 'The other system asked us to slow down',
  unknown: 'The other system refused it'
}

/** Classes where repeating the same request can work: nothing about the record was wrong. */
const NOT_THE_RECORD = new Set(['transient', 'rate_limited', 'auth'])

/** "in 25 min" / "in 2h" / "on the next check" for a ladder retry time. */
export function retryWhen(iso: string, now: number = serverNow()): string {
  const mins = Math.ceil((new Date(iso).getTime() - now) / 60_000)
  if (!Number.isFinite(mins) || mins <= 0) return 'on the next check'
  if (mins < 60) return `in ${mins} min`
  return `in ${Math.round(mins / 60)}h`
}

export interface EventWordsOptions {
  now?: number
  /** "Started automatically" / "You started it" for the run (BackgroundMove startedBy). */
  startedBy?: string | null
  /** A host's own reading of a stored reason it knows (MoveProblemWordsContext). */
  hostWords?: string | null
  /** The move can be run again from this notice (Try again). */
  canRetry?: boolean
  /** The record's Integrations dialog can be opened from this notice. */
  canOpenIntegrations?: boolean
  /** Other moves the person may make by hand are on offer. */
  canMoveByHand?: boolean
  /** Formats a moment (default atClock in the display time zone). Tests pass a fixed one. */
  time?: (iso: string) => string
}

export interface EventWords {
  /** The move's name, bold at the start of the first line. */
  label: string
  /** What follows the name: "did not go through. The record was not moved." */
  headline: string
  /** The reason, said once (the partner's words quoted). Empty = none known. */
  reason: string
  /** The reason is a host's curated text, shown whole (one line per "\n"). */
  reasonFromHost: boolean
  /** What to do now, in one or two sentences. */
  next: string
  /** The quiet last line: who started it, when (unless the reason says when), attempts. */
  meta: string
  /** For "Details for support": the stored text and the HTTP status in it. */
  raw: string | null
  status: number | null
  errorClass: string | null
  ids: Array<{ label: string; value: string }>
}

const PROBLEM_SENTENCE: Record<MoveProblem['result'], string> = {
  refused: 'did not go through. The record was not moved.',
  interrupted: 'stopped before it finished.',
  failed: 'ran into a problem.'
}

/** The one notice's words for a composed event. */
export function pipelineEventWords(ev: PipelineEvent, opts: EventWordsOptions = {}): EventWords {
  const now = opts.now ?? serverNow()
  const time = opts.time ?? ((iso: string) => atClock(iso, now))
  const { problem, held, send } = ev
  const label =
    problem?.transition_label?.trim() || held?.transition_label?.trim() || 'An automatic move'
  const raw = (problem?.reason ?? held?.error ?? send?.reason ?? '').trim() || null
  const errorClass = (send?.error_class ?? held?.error_class ?? null)?.toLowerCase() ?? null
  const sendWords = send ? sendStatusWords(send, { now }) : null

  // The reason, once: a host's reading wins; then the partner's own first sentence from the
  // send (it carries the partner's name and the time); else the stored reason read plainly.
  let reason = ''
  let saysWhen = false
  if (opts.hostWords?.trim()) reason = opts.hostWords.trim()
  else if (sendWords?.lead) {
    reason = sendWords.lead
    saysWhen = /\b(at|on) .*\d{1,2}:\d{2}/.test(sendWords.lead)
  } else if (raw) {
    const r = sendReason(withoutMoveLabel(raw, label))
    const bare = !r.quoted && /^The other system refused the request\.?$/.test(r.text)
    if (r.quoted)
      reason = `${ERROR_CLASS_TEXT[errorClass ?? ''] ?? 'The other system refused it'}: “${r.text}.”`
    else if (r.text && !bare) reason = /[.!?…]$/.test(r.text) ? r.text : `${r.text}.`
    else if (errorClass && ERROR_CLASS_TEXT[errorClass]) reason = `${ERROR_CLASS_TEXT[errorClass]}.`
  }

  const headline = problem
    ? PROBLEM_SENTENCE[problem.result]
    : 'did not go through. The record was not moved.'

  // What to do, once.
  const next: string[] = []
  const sendRetry = send?.retry?.at ? send.retry : null
  if (sendRetry) {
    next.push(
      `It is tried again ${retryWhen(sendRetry.at, now)} (attempt ${sendRetry.attempt} of ${sendRetry.of}).`
    )
  } else if (held?.retry_at) {
    next.push(`It tries the same push again ${retryWhen(held.retry_at, now)}.`)
  } else if (errorClass === 'auth') {
    next.push('An administrator needs to check the connection to the other system.')
  } else if (errorClass && NOT_THE_RECORD.has(errorClass)) {
    next.push(
      opts.canRetry
        ? 'Nothing on the record needs to change: try again.'
        : opts.canOpenIntegrations
          ? 'Nothing on the record needs to change: send it again from Integrations.'
          : 'Nothing on the record needs to change: ask an administrator to send it again.'
    )
  } else {
    const fix = reason ? 'Change that on the record' : 'Check the record'
    if (held)
      next.push(
        `It won’t send the same request again. ${fix} and it sends again by itself${
          opts.canRetry ? ', or try again' : ''
        }.`
      )
    else if (opts.canRetry) next.push(`${fix}, then try again.`)
    else if (opts.canOpenIntegrations) next.push(`${fix}, then send it again from Integrations.`)
    else next.push(`${fix}, then ask for the move to be made again.`)
  }
  if (opts.canMoveByHand) next.push('Or move the record by hand.')

  const whenIso = send
    ? (send.finished_at ?? send.started_at)
    : (problem?.finished_at ?? problem?.started_at ?? held?.last_failed_at ?? null)
  const meta = [
    opts.startedBy ?? (held && !problem ? 'Started automatically' : null),
    !saysWhen && whenIso ? time(whenIso) : null,
    held && held.attempts > 1 ? `${held.attempts} attempts` : null
  ]
    .filter(Boolean)
    .join(' · ')

  const statusMatch = raw ? /\bHTTP (\d{3})\b/.exec(raw) : null
  const ids: EventWords['ids'] = []
  if (problem) ids.push({ label: 'Run', value: `#${problem.id}` })
  if (send) ids.push({ label: 'Send', value: `#${send.id} (${send.api})` })
  const txId = problem?.transition_id ?? held?.transition_id ?? null
  if (txId) ids.push({ label: 'Transition', value: txId })

  return {
    label,
    headline,
    reason,
    reasonFromHost: !!opts.hostWords?.trim(),
    next: next.join(' '),
    meta,
    raw,
    status: statusMatch ? Number(statusMatch[1]) : null,
    errorClass,
    ids
  }
}
