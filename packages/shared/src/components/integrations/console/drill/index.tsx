import type { SignalDrill } from '../types'
import { ImportRunDrill } from './ImportRunDrill'
import { SubmissionDrill } from './SubmissionDrill'

export { AttemptHistory } from './attempts'
export { ImportRunDrill } from './ImportRunDrill'
export { CodeBlock, HeaderTable, isTruncatedBody, pretty } from './json'
export { RequesterChip } from './requester'
export { SubmissionDrill, type SubmissionDrillProps } from './SubmissionDrill'
export { HttpStatusChip, StatusPill } from './status'
export {
  type CallTriggerInfo,
  callTriggerRequester,
  describeCallTrigger,
  TriggerChip
} from './trigger'

/** The drill kinds this console knows how to open. */
export const DRILL_KINDS = new Set(['submission', 'import_run'])

/** A row's drill is openable when its kind is known and its id is a positive integer. */
export function canDrill(drill: SignalDrill | undefined): drill is SignalDrill {
  return !!drill && DRILL_KINDS.has(drill.kind) && /^\d+$/.test(String(drill.id))
}

/**
 * Opens a row's typed drill reference in place. An unknown kind renders
 * nothing — an extension may name a kind a newer console knows about.
 */
export function RowDrill({
  drill,
  onOpenRecord,
  onRetry,
  retryBusy
}: {
  drill: SignalDrill
  onOpenRecord?: (collection: string, id: string) => void
  onRetry?: () => void
  retryBusy?: boolean
}) {
  if (!canDrill(drill)) return null
  const id = Number(drill.id)
  if (drill.kind === 'submission')
    return (
      <SubmissionDrill
        id={id}
        onOpenRecord={onOpenRecord}
        onRetry={onRetry}
        retryBusy={retryBusy}
      />
    )
  if (drill.kind === 'import_run') return <ImportRunDrill id={id} />
  return null
}
