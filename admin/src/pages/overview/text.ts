/**
 * The Overview's sentences — pure, so the wording is tested once and every surface agrees.
 */

const MINUS = '−'
const nf = new Intl.NumberFormat('en-US')
export const fmt = (n: number) => nf.format(n)

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmt(n)} ${n === 1 ? one : many}`
}

export type DeltaTone = 'up' | 'down' | 'flat'

export interface DeltaText {
  tone: DeltaTone
  /** "+12", "−3", "Same" */
  short: string
  /** "12 more than this time yesterday" — the accessible / tooltip reading. */
  long: string
}

/**
 * A figure against its comparison. `compare` names what `previous` is; null previous = nothing
 * to say (the caller shows no chip).
 */
export function deltaText(
  value: number,
  previous: number | null | undefined,
  compare: 'yesterday' | 'previous_24h'
): DeltaText | null {
  if (previous == null || !Number.isFinite(previous)) return null
  const against = compare === 'yesterday' ? 'this time yesterday' : 'the 24 hours before'
  const d = value - previous
  if (d === 0) return { tone: 'flat', short: 'Same', long: `The same as ${against}` }
  const abs = Math.abs(d)
  return d > 0
    ? { tone: 'up', short: `+${fmt(abs)}`, long: `${fmt(abs)} more than ${against}` }
    : { tone: 'down', short: `${MINUS}${fmt(abs)}`, long: `${fmt(abs)} fewer than ${against}` }
}

export function partOfDay(hour: number): 'morning' | 'afternoon' | 'evening' {
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}

/**
 * "Good evening, Robert — 4 things need you, 2 changed on your records". Zero parts are left
 * out; with nothing to say the greeting stands alone. `null` counts are unknown (still loading).
 */
export function greetingSentence(opts: {
  hour: number
  name: string | null | undefined
  needsYou?: number | null
  myRecordsChanged?: number | null
}): { greeting: string; detail: string | null } {
  const name = opts.name?.trim()
  const greeting = `Good ${partOfDay(opts.hour)}${name ? `, ${name}` : ''}`
  const parts: string[] = []
  if (opts.needsYou && opts.needsYou > 0)
    parts.push(`${fmt(opts.needsYou)} ${opts.needsYou === 1 ? 'thing needs' : 'things need'} you`)
  if (opts.myRecordsChanged && opts.myRecordsChanged > 0)
    parts.push(`${fmt(opts.myRecordsChanged)} changed on your records`)
  return { greeting, detail: parts.length ? parts.join(', ') : null }
}

const DAY_MS = 86_400_000

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** "2:15 PM" today, "yesterday", "Tuesday" within the week, else "Oct 12". */
export function sincePhrase(since: Date, now: Date): string {
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(since)) / DAY_MS)
  if (days <= 0) return since.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'yesterday'
  if (days < 7) return since.toLocaleDateString('en-US', { weekday: 'long' })
  return since.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(since.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {})
  })
}

export interface SinceDigestInput {
  since: string
  clamped: boolean
  records_changed: number
  records_capped?: boolean
  my_records_changed: number
  new_people: number | null
  failed_jobs: number | null
  release: { from: string; to: string } | null
}

/**
 * "Since Tuesday: 38 records changed, 1 release, 1 new person". Zero parts are left out; with
 * nothing new: "Nothing new since Tuesday."
 */
export function digestSentence(d: SinceDigestInput, now: Date): string {
  const lead = d.clamped ? 'In the last 14 days' : `Since ${sincePhrase(new Date(d.since), now)}`
  const parts: string[] = []
  if (d.records_changed > 0)
    parts.push(
      `${fmt(d.records_changed)}${d.records_capped ? '+' : ''} ${
        d.records_changed === 1 ? 'record' : 'records'
      } changed`
    )
  if (d.my_records_changed > 0) parts.push(`${fmt(d.my_records_changed)} of yours`)
  if (d.release) parts.push('1 release')
  if (d.new_people && d.new_people > 0) parts.push(plural(d.new_people, 'new person', 'new people'))
  if (d.failed_jobs && d.failed_jobs > 0) parts.push(plural(d.failed_jobs, 'failed job'))
  if (parts.length === 0)
    return d.clamped ? 'Nothing new in the last 14 days.' : `Nothing new since ${lead.slice(6)}.`
  return `${lead}: ${parts.join(', ')}`
}

/** The person's first name for the greeting (never the email's local part dressed up). */
export function firstName(user: { first_name?: string | null; email?: string | null } | null) {
  const f = user?.first_name?.trim()
  if (f) return f
  return user?.email ?? null
}
