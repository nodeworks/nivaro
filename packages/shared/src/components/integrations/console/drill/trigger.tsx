import type { DrillUser, Requester } from '../types'
import { RequesterChip } from './requester'

export interface CallTriggerInfo {
  kind: Requester['kind']
  label: string
}

/** "sync-inventory" → "Sync inventory". */
function humanize(slug: string): string {
  const s = slug.replace(/[-_]+/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : slug
}

const NAMED_TRIGGERS: Record<string, CallTriggerInfo> = {
  test: { kind: 'machine', label: 'The Test button' },
  'transition-action': { kind: 'machine', label: 'A transition action' },
  'erp-submission': { kind: 'machine', label: 'The push API' },
  contract: { kind: 'scheduled', label: 'A contract check' },
  'sync-job': { kind: 'scheduled', label: 'A sync job' },
  // The generic fallback a caller's own `_log.triggeredBy` degrades to when
  // it names nothing more specific.
  extension: { kind: 'machine', label: 'An extension' }
}

const PREFIXED_TRIGGERS: Array<[RegExp, (id: string) => CallTriggerInfo]> = [
  [/^flow:(.+)$/, (id) => ({ kind: 'flow', label: `Flow #${id}` })],
  [/^cron:(.+)$/, (id) => ({ kind: 'scheduled', label: `Scheduled — ${humanize(id)}` })],
  [/^extension:(.+)$/, (id) => ({ kind: 'machine', label: `Extension — ${id}` })],
  [/^custom-action:(.+)$/, (id) => ({ kind: 'machine', label: `Custom action #${id}` })],
  [/^item-action:(.+)$/, (id) => ({ kind: 'machine', label: `Item action — ${humanize(id)}` })]
]

/**
 * What a call log's `triggered_by` value says sent it — a recorded fact, not
 * an inference (unlike `Requester` in requester.tsx, which reconstructs who
 * sent a PUSH from several clues). A resolved `user` always wins; otherwise
 * a literal reading of the stored string. An unrecognized value is shown
 * verbatim rather than swallowed, so a new trigger string is never invisible.
 */
export function describeCallTrigger(
  triggeredBy: string | null,
  user: DrillUser | null
): CallTriggerInfo {
  if (user) return { kind: 'person', label: user.name }
  const tb = (triggeredBy ?? '').trim()
  if (!tb) return { kind: 'unknown', label: 'Not recorded' }
  if (tb in NAMED_TRIGGERS) return NAMED_TRIGGERS[tb]
  for (const [re, build] of PREFIXED_TRIGGERS) {
    const m = re.exec(tb)
    if (m) return build(m[1])
  }
  return { kind: 'unknown', label: tb }
}

/**
 * Adapts a call's trigger + resolved user into the same `Requester` shape
 * the push drill-down (`SubmissionDrill`) uses, so a call's Triggered-by
 * renders through the ONE chip (`RequesterChip`) instead of a second,
 * drifting copy of its avatar/icon logic. `basis` is always `'recorded'`
 * except when nothing at all was stored — a call's own `triggered_by` is
 * never an inference, so `'inferred'` never applies here.
 */
export function callTriggerRequester(
  triggeredBy: string | null,
  user: DrillUser | null
): Requester {
  const info = describeCallTrigger(triggeredBy, user)
  const nothingRecorded = !user && !(triggeredBy ?? '').trim()
  return {
    kind: info.kind,
    basis: nothingRecorded ? 'none' : 'recorded',
    label: info.label,
    user: info.kind === 'person' ? user : null,
    via: null,
    how: null
  }
}

/**
 * Who/what sent a call — a person (avatar + name, an inactive or machine
 * account marked, exactly as the push drill-down marks one) or the recorded
 * machine origin with its own glyph. `size='sm'` fits a row's own summary
 * line; `'md'` (default) fits the expanded Triggered-by section.
 */
export function TriggerChip({
  triggeredBy,
  user,
  size = 'md'
}: {
  triggeredBy: string | null
  user: DrillUser | null
  size?: 'sm' | 'md'
}) {
  return <RequesterChip r={callTriggerRequester(triggeredBy, user)} size={size} />
}
