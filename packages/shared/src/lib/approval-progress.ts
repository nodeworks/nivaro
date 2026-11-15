import { atClock } from './send-status'

/**
 * Approval progress in words (rt4 #8): what each step of an approval chain says as
 * people act on it — "Waiting on Jane Doe, Mark Li" on the step the record is at,
 * "Approved by Beth Lee at 10:42 AM" on a step it has left. Shared by the pipeline's
 * approval chain popover and the parallel-branch lanes.
 */

/** "Jane Doe, Mark Li" — three names at most, then "and N more". */
export function namesList(names: string[]): string {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
  if (clean.length <= 3) return clean.join(', ')
  return `${clean.slice(0, 3).join(', ')} and ${clean.length - 3} more`
}

const PAST: Array<[RegExp, string]> = [
  [/^approve\b/i, 'Approved'],
  [/^reject\b/i, 'Rejected'],
  [/^decline\b/i, 'Declined'],
  [/^submit\b/i, 'Submitted'],
  [/^send back\b/i, 'Sent back'],
  [/^send\b/i, 'Sent'],
  [/^return\b/i, 'Returned'],
  [/^complete\b/i, 'Completed'],
  [/^accept\b/i, 'Accepted'],
  [/^review\b/i, 'Reviewed'],
  [/^sign off\b/i, 'Signed off'],
  [/^confirm\b/i, 'Confirmed'],
  [/^release\b/i, 'Released'],
  [/^close\b/i, 'Closed'],
  [/^cancel\b/i, 'Cancelled']
]

/**
 * A move's label as something that happened: "Approve" → "Approved", "Send back to
 * requester" → "Sent back to requester". A label already in the past ("Approved")
 * stays; one this does not know returns null (the caller says it another way).
 */
export function pastMove(label: string | null | undefined): string | null {
  const text = (label ?? '').trim()
  if (!text) return null
  for (const [re, past] of PAST) if (re.test(text)) return text.replace(re, past)
  if (/^[A-Za-z]+ed\b/.test(text)) return text
  return null
}

export interface ChainStepMove {
  /** The state the record left. */
  from_state: string | null
  transition_label?: string | null
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
  timestamp: string
}

const personOf = (m: ChainStepMove): string =>
  [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || m.user_email?.trim() || ''

/**
 * What one chain step says: null when nothing is known yet (a step still ahead).
 * `history` is the record's moves, any order; the newest move out of the step speaks.
 */
export function chainStepText(opts: {
  stateId: string
  currentStateId: string | null | undefined
  history: ChainStepMove[]
  /** The people who own the step now (shown only on the current step). */
  owners?: string[]
  now?: number
}): { kind: 'waiting' | 'done'; text: string } | null {
  const now = opts.now ?? Date.now()
  if (opts.stateId === opts.currentStateId) {
    const names = namesList(opts.owners ?? [])
    return names ? { kind: 'waiting', text: `Waiting on ${names}` } : null
  }
  const out = opts.history
    .filter((h) => h.from_state === opts.stateId)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0]
  if (!out) return null
  const who = personOf(out)
  const when = atClock(out.timestamp, now)
  const past = pastMove(out.transition_label)
  if (past)
    return { kind: 'done', text: `${past}${who ? ` by ${who}` : ''}${when ? ` at ${when}` : ''}` }
  const label = out.transition_label?.trim() || 'Moved on'
  return { kind: 'done', text: `${label}${who ? ` — ${who}` : ''}${when ? ` at ${when}` : ''}` }
}

/**
 * One decision row of an approval chain (routes/approvals.ts): "Approved by Beth Lee at
 * 10:42 AM", "Rejected by Mark Li at 9:05 AM", or "Waiting on Jane Doe" on the step the
 * chain is at. Null for a step still ahead.
 */
export function approvalDecisionText(
  d: {
    decision?: string | null
    status?: string | null
    approver_name?: string | null
    decided_at?: string | null
  },
  isCurrent: boolean,
  now: number = Date.now()
): string | null {
  const v = String(d.decision ?? d.status ?? 'pending').toLowerCase()
  const who = d.approver_name?.trim() || ''
  const when = d.decided_at ? atClock(d.decided_at, now) : ''
  if (v === 'approved' || v === 'rejected') {
    const word = v === 'approved' ? 'Approved' : 'Rejected'
    return `${word}${who ? ` by ${who}` : ''}${when ? ` at ${when}` : ''}`
  }
  if (isCurrent) return who ? `Waiting on ${who}` : 'Waiting'
  return null
}
