import { toneForOutcome } from './obligation-filters'
import { formatDate, getDisplayTimezone } from './utils'

export interface BannerLine {
  api: string
  tone: 'danger' | 'warning' | 'neutral' | 'positive'
  text: string
  obligation_id: number
  outcome: string
  /** The submission this obligation tracks (null for a `missing` row). */
  submission_id: number | null
  /** The transition that owns a transition-triggered obligation — the
   *  actionable fix is to run it again (after fixing what the partner
   *  rejected). Null for hook / flow / cron obligations. */
  transition_id: string | null
  transition_label: string | null
}

interface Row {
  id: number
  api: string
  kind: string
  outcome: string
  reason: string | null
  due_at: string
  resolved_at: string | null
  /** 'transition' | 'hook' | 'flow' | 'cron' | 'reconcile' | 'manual' —
   *  kept as a bare string rather than importing the server's
   *  ObligationTrigger union into this client lib for one comparison, so a
   *  new trigger kind added server-side never breaks this file's build. */
  trigger?: string
  /** The kind's human label from the registry ("Fusion — transfer order
   *  submitted"); null when the server no longer knows the kind. */
  label?: string | null
  submission_id?: number | null
  transition_id?: string | null
  transition_label?: string | null
}

/** "14:02" in the viewer's preferred zone — `getDisplayTimezone()` is the
 *  exact singleton `formatDateTime`/`formatRelative` themselves read, so
 *  this honours the same viewer preference those helpers do. Not a literal
 *  call to `formatDateTime()`, whose own output carries a full date — too
 *  long for one banner line; this keeps the compact HH:MM shape while
 *  sharing its timezone resolution. Replaces the original cut's
 *  `toISOString().slice(11, 16)`, which always rendered the sender's UTC
 *  instant regardless of who was reading it. */
const clock = (iso: string) => {
  const tz = getDisplayTimezone()
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(tz ? { timeZone: tz } : {})
  }).format(new Date(iso))
}

/** How long ago, in `formatRelative()`'s exact wording — reproduced here
 *  rather than calling the real export, because `formatRelative()` reads
 *  the real wall clock (`Date.now()`) and `bannerLines()` is deliberately
 *  pure over an explicit `now` so its output is unit-testable without
 *  waiting for a specific wall-clock moment (the existing `pending` test
 *  already relies on that explicit-`now` contract). Falls back to the real
 *  `formatDate()` past a week, the same threshold `formatRelative()` itself
 *  uses — so the tail end of this DOES call a shared formatter directly. */
function relativeFrom(iso: string, now: Date): string {
  const diff = now.getTime() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return formatDate(iso)
}

/** A transition-triggered obligation's OWN `trigger_ref` is an opaque
 *  transition id (see `workflow-actions.ts`'s `erp_submit` action, which
 *  opens the obligation with `trigger_ref: opts.transition.id`) — and the
 *  per-record route does not even SELECT `trigger_ref` today, so there is
 *  never a human label to name the transition by ("Approve → Waiting on
 *  Level 2") from this payload alone, opaque id or not. The kind's own
 *  machine key IS in the payload; humanized, it is the best available
 *  "what kind of message this was" context reachable without a new fetch. */
function humanizeKind(kind: string): string {
  return kind
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

/** Newest obligation per partner, in the words the record's reader needs:
 *  when they were told, or when they should have been and why not. Pure —
 *  no fetch, so it's unit-testable without a DOM and reusable by the record
 *  banner AND anywhere else that ends up wanting the same sentence. */
export function bannerLines(rows: Row[], now: Date = new Date()): BannerLine[] {
  const newest = new Map<string, Row>()
  for (const r of rows) {
    if (r.outcome === 'superseded') continue
    const cur = newest.get(r.api)
    if (!cur || r.id > cur.id) newest.set(r.api, r)
  }
  return [...newest.values()].map((r) => {
    const source = r.resolved_at ?? r.due_at
    // "5m ago (2:09 PM)": the relative wording people scan for, the clock
    // for the record — never a bare 24-hour stamp.
    const when = `${relativeFrom(source, now)} (${clock(source)})`
    const why = r.reason ? ` — ${r.reason}` : ''
    const what = r.label?.trim() || (r.trigger === 'transition' ? humanizeKind(r.kind) : '')
    const ctx = what ? ` · ${what}` : ''
    let text: string
    if (r.outcome === 'sent') text = `told ${when}${ctx}`
    else if (r.outcome === 'pending') {
      const mins = Math.round((now.getTime() - new Date(r.due_at).getTime()) / 60_000)
      text = `sent ${when}${ctx}, awaiting acknowledgement (${mins} min)`
    } else if (r.outcome === 'skipped') text = `should have been told ${when}${ctx}${why}`
    else if (r.outcome === 'failed') text = `send failed ${when}${ctx}${why}`
    else if (r.outcome === 'missing') text = `never told${ctx}${why}`
    else text = `still not told${ctx}${why}`
    return {
      api: r.api,
      tone: toneForOutcome(r.outcome),
      text,
      obligation_id: r.id,
      outcome: r.outcome,
      submission_id: r.submission_id ?? null,
      transition_id: r.transition_id ?? null,
      transition_label: r.transition_label ?? null
    }
  })
}
